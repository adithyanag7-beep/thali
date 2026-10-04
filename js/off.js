// Barcode lookups: first this phone's remembered products, then Open Food Facts.

import { CONFIG } from './config.js';
import { db } from './store.js';
import { kcalFromOff, nonNeg, round } from './nutrition.js';

export function cleanBarcode(s) {
  return String(s || '').replace(/\D/g, '');
}

// GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14).
export function checksumOk(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// Different lengths of the same code, so a UPC-A matches its EAN-13 form.
function variants(code) {
  const v = [code];
  if (code.length === 12) v.push('0' + code);
  if (code.length === 13 && code.startsWith('0')) v.push(code.slice(1));
  if (code.length === 14 && code.startsWith('0')) v.push(code.slice(1));
  return [...new Set(v)];
}

export async function findRemembered(code) {
  for (const c of variants(code)) {
    const p = await db.get('products', c);
    if (p) return p;
  }
  return null;
}

export async function rememberProduct(product) {
  await db.put('products', { ...product, updatedAt: new Date().toISOString() });
}

// Returns { status: 'found' | 'no_nutrition' | 'not_found', product? }
// Throws { code: 'offline' | 'network' | 'server' } on connection problems.
export async function lookupOFF(code) {
  for (const c of variants(code)) {
    const r = await fetchOne(c);
    if (r.status !== 'not_found') return r;
  }
  return { status: 'not_found' };
}

async function fetchOne(code) {
  const url = `${CONFIG.OFF_PRODUCT_URL}${encodeURIComponent(code)}.json?fields=${CONFIG.OFF_FIELDS}`;
  let resp;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch {
    const err = new Error(navigator.onLine === false
      ? 'You’re offline. Connect to the internet to look up new barcodes. Products you’ve scanned before still work offline.'
      : 'Couldn’t reach Open Food Facts. Check your connection and try again.');
    err.code = navigator.onLine === false ? 'offline' : 'network';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await resp.json(); } catch { /* not JSON */ }
  if (resp.status === 404 || (json && (json.status === 0 || json.status === 'failure') && !json.product)) {
    return { status: 'not_found' };
  }
  if (!resp.ok || !json) {
    const err = new Error('Open Food Facts isn’t answering right now. Try again in a minute, or type the values yourself.');
    err.code = 'server';
    throw err;
  }
  const p = json.product || {};
  const n = p.nutriments || {};
  const kcal = kcalFromOff(n);
  const name = (p.product_name || p.product_name_en || p.generic_name || '').trim();
  const brand = String(p.brands || '').split(',')[0].trim();
  const servingG = nonNeg(p.serving_quantity) || gramsFromText(p.serving_size);
  const unitText = `${p.quantity || ''} ${p.serving_size || ''}`.toLowerCase();
  const product = {
    barcode: code,
    name: name || 'Unnamed product',
    brand,
    per100: {
      kcal: kcal === null ? 0 : round(kcal, 0),
      protein: round(nonNeg(n.proteins_100g), 1),
      carbs: round(nonNeg(n.carbohydrates_100g), 1),
      fat: round(nonNeg(n.fat_100g), 1),
    },
    servingG: round(servingG, 1),
    servingDesc: String(p.serving_size || '').slice(0, 60),
    unit: /\bml\b|\bl\b|litre|liter/.test(unitText) && !/\bg\b/.test(unitText) ? 'ml' : 'g',
    source: 'off',
  };
  if (kcal === null) return { status: 'no_nutrition', product };
  return { status: 'found', product };
}

function gramsFromText(s) {
  const m = String(s || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(g|ml)\b/);
  return m ? parseFloat(m[1].replace(',', '.')) : 0;
}
