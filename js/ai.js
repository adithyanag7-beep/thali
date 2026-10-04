// Talks to the Claude API directly from the phone.
// Requests use structured outputs (output_config.format) so the answer is JSON
// that matches the schema; the parser below still checks and repairs it.

import { CONFIG } from './config.js';
import { getApiKey, recordUsage } from './store.js';
import { makeItem, nonNeg, round } from './nutrition.js';

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Prompts ────────────────────────────────────────────────────
const MEAL_SYSTEM = `You are a dietitian and an expert in Indian home cooking across all regions: North Indian (roti, phulka, paratha, dal tadka, dal makhani, rajma, chole, kadhi, sabzi, paneer dishes), South Indian (idli, dosa, uttapam, sambar, rasam, poriyal, kootu, curd rice, upma, pongal), biryani and pulao, Gujarati, Bengali, Maharashtrian, Punjabi and other regional food, plus everyday non-Indian food.

Estimate what was eaten from the photo and/or description.
- List each dish separately with a plain common name, e.g. "Dal tadka", "Phulka", "Aloo gobi".
- portion: describe it in household units first (roti or piece count, katori about 150 ml, ladle about 60 ml, cup about 240 ml, tbsp, tsp), then grams, e.g. "1 katori (150 g)" or "2 phulkas (60 g)".
- grams: weight of the portion eaten.
- kcal, protein_g, carbs_g, fat_g: for the whole portion eaten, not per 100 g.
- Energy is always in kilocalories (kcal). Never use kilojoules.
- Home cooking hides oil and ghee: tadka, ghee on rotis, oil in sabzi and parathas. Estimate it realistically (a home sabzi often has 1-2 tsp oil per katori; restaurant food has more) and include it in the dish it belongs to.
- If the person's note gives details (ghee, amounts, recipe), trust it over what the photo suggests.
- Keep kcal consistent with the macros (about 4 kcal per gram of protein or carbs, 9 per gram of fat).
- confidence: "high" only if the dishes and amounts are clear; "low" if the photo is unclear, food is hidden, or the amount is a guess.
- note: one short sentence (under 25 words) giving the main assumption, usually the oil/ghee or portion size.
- If there is no food, return an empty dishes list and say so in the note.`;

const LABEL_SYSTEM = `You read food packaging photos and report nutrition values.
- Find the nutrition information panel and report values per 100 g (per 100 ml for drinks).
- Energy must be in kilocalories (kcal). Australian and many other labels show only kJ: convert with kcal = kJ / 4.184 and round. If the panel also shows Cal or kcal, use that figure.
- If the panel only gives per-serving values, convert to per 100 g using the serving size.
- serving_g: the serving size printed on the pack in grams (or ml), or 0 if none is shown.
- serving_desc: the serving as printed, e.g. "2 biscuits (25 g)", or an empty string.
- unit: "ml" for drinks measured in ml, otherwise "g".
- from_label: true if you read the numbers from a nutrition panel. If no panel is visible, use typical values for that kind of product, set from_label to false and confidence to "low".
- product_name and brand as printed on the pack (brand empty if unknown).
- note: one short sentence (under 25 words).`;

const num = { type: 'number' };
const str = { type: 'string' };
const confidence = { type: 'string', enum: ['high', 'medium', 'low'] };

const MEAL_SCHEMA = {
  type: 'object',
  properties: {
    dishes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, portion: str, grams: num, kcal: num, protein_g: num, carbs_g: num, fat_g: num },
        required: ['name', 'portion', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
        additionalProperties: false,
      },
    },
    confidence,
    note: str,
  },
  required: ['dishes', 'confidence', 'note'],
  additionalProperties: false,
};

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    product_name: str,
    brand: str,
    per_100: {
      type: 'object',
      properties: { kcal: num, protein_g: num, carbs_g: num, fat_g: num },
      required: ['kcal', 'protein_g', 'carbs_g', 'fat_g'],
      additionalProperties: false,
    },
    serving_g: num,
    serving_desc: str,
    unit: { type: 'string', enum: ['g', 'ml'] },
    from_label: { type: 'boolean' },
    confidence,
    note: str,
  },
  required: ['product_name', 'brand', 'per_100', 'serving_g', 'serving_desc', 'unit', 'from_label', 'confidence', 'note'],
  additionalProperties: false,
};

// ── Public functions ───────────────────────────────────────────

// input: { imageBase64?, text?, note?, model?, signal? }
export async function estimateMeal(input) {
  const content = [];
  if (input.imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.imageBase64 } });
  }
  let prompt;
  if (input.imageBase64) {
    prompt = 'Estimate the food in this photo.';
    if (input.note) prompt += `\nThe person added: "${input.note.trim()}"`;
  } else {
    prompt = `Estimate this meal: "${(input.text || '').trim()}"`;
  }
  content.push({ type: 'text', text: prompt });

  const res = await callClaude({ model: input.model, system: MEAL_SYSTEM, content, schema: MEAL_SCHEMA, signal: input.signal });
  return { ...res, result: cleanMeal(res.data) };
}

// input: { imageBase64, note?, barcode?, model?, signal? }
export async function readLabel(input) {
  let prompt = 'Read the nutrition information from this packaging.';
  if (input.note) prompt += `\nThe person added: "${input.note.trim()}"`;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.imageBase64 } },
    { type: 'text', text: prompt },
  ];
  const res = await callClaude({ model: input.model, system: LABEL_SYSTEM, content, schema: LABEL_SCHEMA, signal: input.signal });
  return { ...res, result: cleanLabel(res.data) };
}

// Checks the key with the smallest possible request (a fraction of a cent).
export async function testKey(key) {
  let resp;
  const model = CONFIG.MODELS.fast;
  try {
    resp = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }),
    });
  } catch {
    throw networkError();
  }
  if (!resp.ok) throw await httpError(resp, model);
  try { recordUsage(model, (await resp.json()).usage); } catch { /* ignore */ }
  return true;
}

// ── Request ────────────────────────────────────────────────────
function headers(key) {
  return {
    'x-api-key': key,
    'anthropic-version': CONFIG.ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function callClaude({ model, system, content, schema, signal }) {
  const key = getApiKey();
  if (!key) throw new AIError('no_key', 'Add your Claude API key in Settings first.');
  const modelId = model || CONFIG.MODELS.fast;

  const body = {
    model: modelId,
    max_tokens: CONFIG.MAX_TOKENS,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
    ...(CONFIG.MODEL_EXTRA_PARAMS[modelId] || {}),
  };

  const ctrl = new AbortController();
  let why = '';
  const timer = setTimeout(() => { why = 'timeout'; ctrl.abort(); }, CONFIG.REQUEST_TIMEOUT_MS);
  const onAbort = () => { why = 'cancelled'; ctrl.abort(); };
  if (signal) signal.addEventListener('abort', onAbort);

  let resp;
  try {
    resp = await fetch(CONFIG.API_URL, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) {
      if (why === 'cancelled') throw new AIError('cancelled', 'Cancelled.');
      throw new AIError('timeout', 'Claude took too long to answer. Check your connection and try again.');
    }
    throw networkError();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!resp.ok) throw await httpError(resp, modelId);

  let json;
  try { json = await resp.json(); } catch { throw new AIError('parse', 'Claude’s answer came back damaged. Try again.'); }

  recordUsage(modelId, json.usage);

  if (json.stop_reason === 'refusal') {
    throw new AIError('refusal', 'Claude declined to answer this one. Try a different photo, or type what you ate.');
  }
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const data = parseJSONLoose(text);
  if (!data) {
    if (json.stop_reason === 'max_tokens') {
      throw new AIError('truncated', 'The answer was cut short. Try again, or log fewer dishes at a time.');
    }
    throw new AIError('parse', 'Claude’s answer came back in an unexpected format. Try again.');
  }
  return { data, model: modelId, usage: json.usage, truncated: json.stop_reason === 'max_tokens' };
}

function networkError() {
  if (navigator.onLine === false) {
    return new AIError('offline', 'You’re offline. Connect to Wi-Fi or mobile data to get an estimate.');
  }
  return new AIError('network', 'Couldn’t reach Claude. Check your internet connection and try again.');
}

async function httpError(resp, modelId) {
  let type = '', message = '';
  try {
    const j = await resp.json();
    type = j?.error?.type || '';
    message = j?.error?.message || '';
  } catch { /* not JSON */ }
  const lower = message.toLowerCase();
  const s = resp.status;
  if (s === 401) return new AIError('bad_key', 'Your API key wasn’t accepted. Check it in Settings: it should start with “sk-ant-”.');
  if (s === 403) return new AIError('forbidden', 'This API key isn’t allowed to do that. Check the key’s permissions in the Anthropic Console.');
  if (lower.includes('credit balance')) return new AIError('no_credit', 'Your Anthropic account is out of credit. Add credit under Billing in the Anthropic Console.');
  if (lower.includes('spend limit') || lower.includes('usage limit')) return new AIError('limit', 'You’ve reached the spending limit set on your Anthropic account. Raise it in the Console or wait until next month.');
  if (s === 404 || type === 'not_found_error') return new AIError('model', `The model “${modelId || ''}” wasn’t found. It may have been renamed; update MODELS in js/config.js.`);
  if (s === 413) return new AIError('too_large', 'That photo is too large. Try again with a different photo.');
  if (s === 429) return new AIError('rate_limit', 'Too many requests in a short time. Wait a minute, then try again.');
  if (s === 529 || type === 'overloaded_error') return new AIError('overloaded', 'Claude is very busy right now. Try again in a minute.');
  if (s >= 500) return new AIError('server', 'Claude had a problem on its side. Try again in a moment.');
  if (s === 400) {
    const short = message.length > 160 ? message.slice(0, 157) + '…' : message;
    return new AIError('bad_request', `Claude couldn’t process this request${short ? `: ${short}` : '.'}`);
  }
  return new AIError('http', `Something went wrong (error ${s}). Try again.`);
}

// ── JSON parsing and repair ────────────────────────────────────
export function parseJSONLoose(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  if (start === -1) return null;
  t = t.slice(start);
  try { return JSON.parse(t); } catch { /* try harder */ }
  const end = t.lastIndexOf('}');
  if (end !== -1) {
    try { return JSON.parse(t.slice(0, end + 1)); } catch { /* keep going */ }
  }
  return repairJSON(t);
}

// Closes strings, arrays and objects left open by a cut-off answer, removes
// trailing commas, and drops a dangling half-written value.
function repairJSON(t) {
  let s = t.replace(/,\s*([}\]])/g, '$1');
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) s += '"';
  // Remove an incomplete trailing "key": or "key": partial-number, or trailing comma.
  s = s.replace(/,\s*"[^"]*"\s*:\s*("[^"]*"?|[-\d.]*)?\s*$/, '').replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) s += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(s); } catch { return null; }
}

// ── Cleaning the answer ────────────────────────────────────────
function pickConfidence(v) {
  const c = String(v || '').toLowerCase();
  return c === 'high' || c === 'medium' || c === 'low' ? c : 'medium';
}

function cleanMeal(data) {
  const raw = Array.isArray(data?.dishes) ? data.dishes : Array.isArray(data?.items) ? data.items : [];
  const items = raw
    .filter(d => d && typeof d === 'object')
    .map(d => {
      const protein = nonNeg(d.protein_g ?? d.protein);
      const carbs = nonNeg(d.carbs_g ?? d.carbs);
      const fat = nonNeg(d.fat_g ?? d.fat);
      let kcal = nonNeg(d.kcal ?? d.calories);
      const fromMacros = protein * 4 + carbs * 4 + fat * 9;
      if (!kcal && fromMacros) kcal = fromMacros;
      return makeItem({
        name: d.name || d.dish || 'Food',
        portion: d.portion || '',
        grams: round(nonNeg(d.grams), 0),
        kcal: round(kcal, 0),
        protein: round(protein, 1),
        carbs: round(carbs, 1),
        fat: round(fat, 1),
        qty: 1,
      });
    });
  return {
    items,
    confidence: pickConfidence(data?.confidence),
    note: String(data?.note || '').slice(0, 240),
  };
}

function cleanLabel(data) {
  const p = data?.per_100 || data?.per100 || {};
  const protein = nonNeg(p.protein_g ?? p.protein);
  const carbs = nonNeg(p.carbs_g ?? p.carbs);
  const fat = nonNeg(p.fat_g ?? p.fat);
  let kcal = nonNeg(p.kcal);
  if (!kcal) kcal = protein * 4 + carbs * 4 + fat * 9;
  return {
    name: String(data?.product_name || '').slice(0, 80),
    brand: String(data?.brand || '').slice(0, 60),
    per100: { kcal: round(kcal, 0), protein: round(protein, 1), carbs: round(carbs, 1), fat: round(fat, 1) },
    servingG: round(nonNeg(data?.serving_g), 1),
    servingDesc: String(data?.serving_desc || '').slice(0, 60),
    unit: data?.unit === 'ml' ? 'ml' : 'g',
    fromLabel: data?.from_label !== false,
    confidence: pickConfidence(data?.confidence),
    note: String(data?.note || '').slice(0, 240),
  };
}
