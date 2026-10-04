// Numbers: scaling portions, totals, rounding, meals of the day.

import { CONFIG } from './config.js';

export const MEALS = [
  { id: 'breakfast', name: 'Breakfast' },
  { id: 'lunch', name: 'Lunch' },
  { id: 'dinner', name: 'Dinner' },
  { id: 'snack', name: 'Snacks' },
];
export const MEAL_NAME = Object.fromEntries(MEALS.map(m => [m.id, m.name]));
export const MEAL_SINGULAR = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snacks' };

export function mealForTime(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15.5) return 'lunch';
  if (h >= 18 && h < 23) return 'dinner';
  return 'snack';
}

export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const m = v.replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
export const nonNeg = v => Math.max(0, num(v));

export function round(v, dp = 0) {
  const f = 10 ** dp;
  return Math.round((num(v) + Number.EPSILON) * f) / f;
}

// One food line on an entry. Values are for qty = 1; what was eaten = value × qty.
// For barcode products the base is 100 g (or 100 ml) and per100 = true.
export function makeItem(src = {}) {
  return {
    name: String(src.name || '').slice(0, 80),
    portion: String(src.portion || '').slice(0, 80),
    grams: nonNeg(src.grams),
    kcal: nonNeg(src.kcal),
    protein: nonNeg(src.protein),
    carbs: nonNeg(src.carbs),
    fat: nonNeg(src.fat),
    qty: src.qty > 0 ? num(src.qty) : 1,
    per100: !!src.per100,
    servingG: nonNeg(src.servingG),
    unit: src.unit === 'ml' ? 'ml' : 'g',
  };
}

export function itemTotals(it) {
  const q = it.qty || 0;
  return {
    grams: it.grams * q,
    kcal: it.kcal * q,
    protein: it.protein * q,
    carbs: it.carbs * q,
    fat: it.fat * q,
  };
}

export function sumItems(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const it of items || []) {
    const x = itemTotals(it);
    t.kcal += x.kcal; t.protein += x.protein; t.carbs += x.carbs; t.fat += x.fat;
  }
  return t;
}

export function sumEntries(entries) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries || []) {
    const x = sumItems(e.items);
    t.kcal += x.kcal; t.protein += x.protein; t.carbs += x.carbs; t.fat += x.fat;
  }
  return t;
}

// Portion steps for the − / + buttons.
const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10];
export function stepQty(q, dir) {
  if (dir > 0) return STEPS.find(s => s > q + 1e-9) ?? q + 2;
  const lower = [...STEPS].reverse().find(s => s < q - 1e-9);
  return lower ?? q;
}

const FRACTIONS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
export function qtyLabel(q) {
  const whole = Math.floor(q + 1e-9);
  const frac = round(q - whole, 2);
  if (frac === 0) return String(whole);
  if (FRACTIONS[frac]) return (whole ? whole : '') + FRACTIONS[frac];
  return String(round(q, 2));
}

export const fmtInt = v => Math.round(num(v)).toLocaleString('en-AU');
export function fmtG(v) {
  const n = num(v);
  if (n > 0 && n < 10) return String(round(n, 1));
  return fmtInt(n);
}

// Open Food Facts → per-100 g values in kcal (never kJ).
export function kcalFromOff(n) {
  if (!n) return null;
  const kcal = n['energy-kcal_100g'];
  if (kcal !== undefined && kcal !== null && kcal !== '' && Number.isFinite(Number(kcal))) return Number(kcal);
  const kj = n['energy-kj_100g'] ?? n['energy_100g'];
  if (kj !== undefined && kj !== null && kj !== '' && Number.isFinite(Number(kj))) return Math.round(Number(kj) / CONFIG.KJ_PER_KCAL);
  return null;
}

export function titleFromItems(items) {
  const names = (items || []).map(i => i.name.trim()).filter(Boolean);
  if (!names.length) return 'Food';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
