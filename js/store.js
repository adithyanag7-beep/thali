// Everything is stored on this phone only.
//  - Food log, saved meals and remembered barcodes: IndexedDB (room for photos).
//  - API key, goals and the usage counter: localStorage.

import { CONFIG } from './config.js';

const DB_NAME = 'thali';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser cannot store data.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('saved')) db.createObjectStore('saved', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'barcode' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other copies of the app and try again.'));
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage error'));
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
  put: (store, value) => tx(store, 'readwrite', s => reqP(s.put(value))),
  del: (store, key) => tx(store, 'readwrite', s => reqP(s.delete(key))),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  clear: (store) => tx(store, 'readwrite', s => reqP(s.clear())),
  putMany: (store, values) => tx(store, 'readwrite', s => Promise.all(values.map(v => reqP(s.put(v))))),
  entriesOn: (date) => tx('entries', 'readonly', s => reqP(s.index('date').getAll(date))),
  entriesBetween: (from, to) => tx('entries', 'readonly', s => reqP(s.index('date').getAll(IDBKeyRange.bound(from, to)))),
};

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Dates (always the phone's local time) ──────────────────────
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}
export function addDays(key, n) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

// ── localStorage helpers ───────────────────────────────────────
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const KEY_API = 'thali.apiKey';
const KEY_SETTINGS = 'thali.settings';
const KEY_USAGE = 'thali.usage';
const KEY_FLAGS = 'thali.flags';

export function getApiKey() {
  try { return (localStorage.getItem(KEY_API) || '').trim(); } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_API, key.trim());
    else localStorage.removeItem(KEY_API);
  } catch { /* ignore */ }
}

const DEFAULT_SETTINGS = {
  calorieGoal: CONFIG.DEFAULT_CALORIE_GOAL,
  macroMode: 'auto', // 'auto' | 'custom'
  proteinGoal: 0,
  carbsGoal: 0,
  fatGoal: 0,
  lastBackup: null,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(KEY_SETTINGS, {}) };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJSON(KEY_SETTINGS, next);
  return next;
}

export function macroGoals(settings = getSettings()) {
  const kcal = settings.calorieGoal || CONFIG.DEFAULT_CALORIE_GOAL;
  if (settings.macroMode === 'custom') {
    return {
      kcal,
      protein: settings.proteinGoal || 0,
      carbs: settings.carbsGoal || 0,
      fat: settings.fatGoal || 0,
    };
  }
  const s = CONFIG.AUTO_MACRO_SPLIT;
  return {
    kcal,
    protein: Math.round((kcal * s.protein) / 4),
    carbs: Math.round((kcal * s.carbs) / 4),
    fat: Math.round((kcal * s.fat) / 9),
  };
}

export function getFlags() { return readJSON(KEY_FLAGS, {}); }
export function setFlag(name, value) { writeJSON(KEY_FLAGS, { ...getFlags(), [name]: value }); }

// ── Usage counter ──────────────────────────────────────────────
export function recordUsage(model, usage) {
  const u = readJSON(KEY_USAGE, { days: {} });
  const day = dateKey();
  const d = u.days[day] || { calls: 0, models: {} };
  d.calls += 1;
  const m = d.models[model] || { calls: 0, input: 0, output: 0 };
  m.calls += 1;
  m.input += (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  m.output += usage?.output_tokens || 0;
  d.models[model] = m;
  u.days[day] = d;
  // Keep about 13 months.
  const cutoff = addDays(day, -400);
  for (const k of Object.keys(u.days)) if (k < cutoff) delete u.days[k];
  writeJSON(KEY_USAGE, u);
}

function costOf(models) {
  let cost = 0;
  for (const [id, m] of Object.entries(models)) {
    const p = CONFIG.PRICES_PER_MTOK[id];
    if (p) cost += (m.input * p.input + m.output * p.output) / 1e6;
  }
  return cost;
}

export function usageSummary() {
  const u = readJSON(KEY_USAGE, { days: {} });
  const today = dateKey();
  const month = today.slice(0, 7);
  const sum = (filter) => {
    let calls = 0, cost = 0, input = 0, output = 0;
    for (const [k, d] of Object.entries(u.days)) {
      if (!filter(k)) continue;
      calls += d.calls;
      cost += costOf(d.models);
      for (const m of Object.values(d.models)) { input += m.input; output += m.output; }
    }
    return { calls, cost, input, output };
  };
  return {
    today: sum(k => k === today),
    month: sum(k => k.startsWith(month)),
  };
}
export function resetUsage() { writeJSON(KEY_USAGE, { days: {} }); }

// ── Backup ─────────────────────────────────────────────────────
export async function exportAll() {
  const [entries, saved, products] = await Promise.all([db.all('entries'), db.all('saved'), db.all('products')]);
  const { lastBackup, ...settings } = getSettings();
  return {
    app: 'thali',
    format: 1,
    exportedAt: new Date().toISOString(),
    settings,
    entries,
    saved,
    products,
    usage: readJSON(KEY_USAGE, { days: {} }),
  };
}

export function validateBackup(data) {
  if (!data || typeof data !== 'object') return 'This file is not a Thali backup.';
  if (data.app !== 'thali') return 'This file is not a Thali backup.';
  if (!Array.isArray(data.entries) || !Array.isArray(data.saved)) return 'This backup file is damaged.';
  return null;
}

export async function importAll(data, mode) {
  const clean = (arr, key) => (Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && x[key]) : []);
  const entries = clean(data.entries, 'id').filter(e => typeof e.date === 'string');
  const saved = clean(data.saved, 'id');
  const products = clean(data.products, 'barcode');
  if (mode === 'replace') {
    await db.clear('entries');
    await db.clear('saved');
    await db.clear('products');
  }
  await db.putMany('entries', entries);
  await db.putMany('saved', saved);
  await db.putMany('products', products);
  if (data.settings && typeof data.settings === 'object') {
    const s = data.settings;
    const patch = {};
    for (const k of ['calorieGoal', 'proteinGoal', 'carbsGoal', 'fatGoal']) if (Number.isFinite(s[k])) patch[k] = s[k];
    if (s.macroMode === 'auto' || s.macroMode === 'custom') patch.macroMode = s.macroMode;
    saveSettings(patch);
  }
  if (mode === 'replace' && data.usage && data.usage.days) writeJSON(KEY_USAGE, data.usage);
  return { entries: entries.length, saved: saved.length, products: products.length };
}

export async function eraseEverything() {
  await db.clear('entries');
  await db.clear('saved');
  await db.clear('products');
  for (const k of [KEY_API, KEY_SETTINGS, KEY_USAGE, KEY_FLAGS]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}
