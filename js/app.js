// Thali — the screens and what the buttons do.

import { CONFIG } from './config.js';
import {
  db, newId, dateKey, parseDateKey, addDays, getApiKey, setApiKey, getSettings, saveSettings,
  macroGoals, getFlags, setFlag, usageSummary, resetUsage, exportAll, validateBackup, importAll, eraseEverything,
} from './store.js';
import {
  MEALS, MEAL_NAME, MEAL_SINGULAR, mealForTime, num, nonNeg, round, makeItem, itemTotals, sumItems, sumEntries,
  stepQty, qtyLabel, fmtInt, fmtG, titleFromItems,
} from './nutrition.js';
import { compressPhoto, thumbFromCanvas } from './image.js';
import { estimateMeal, readLabel, testKey, AIError } from './ai.js';
import { cleanBarcode, checksumOk, findRemembered, rememberProduct, lookupOFF } from './off.js';
import { LiveScanner, decodeFromFile, cameraSupported, cameraErrorMessage, warmUp } from './scanner.js';
import { icon } from './icons.js';

// ── State ──────────────────────────────────────────────────────
const S = {
  screen: 'today',
  viewDate: dateKey(),
  followToday: true,   // keep Today on the current day after midnight
  draft: null,         // the entry being checked/edited
  photo: null,         // { dataUrl, base64, thumb } waiting for an estimate
  photoNote: '',
  textInput: '',
  labelFor: null,      // barcode we're photographing the label for
  labelPhoto: null,
  labelNote: '',
  notFound: null,      // { code, status, product? }
  savedId: null,       // saved meal being viewed
  savedFactor: 1,
  savedMeal: null,
  historyDays: 7,
  scanner: null,
  scanError: '',
  typedCode: '',
  aiAbort: null,
};

const TAB_SCREENS = ['today', 'add', 'saved', 'history', 'settings'];
const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $busy = document.getElementById('busy');
const $toast = document.getElementById('toast');
const $modal = document.getElementById('modal');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const modelName = (id) => CONFIG.MODEL_NAMES[id] || id;

function niceDate(key, withYear = false) {
  const d = parseDateKey(key);
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) });
}
function shortDate(key) {
  return parseDateKey(key).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
function timeOf(iso) {
  try { return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}
function dayLabel(key) {
  const today = dateKey();
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  return niceDate(key);
}

// ── Navigation ─────────────────────────────────────────────────
function go(screen, opts = {}) {
  if (S.scanner && screen !== 'scan') { S.scanner.stop(); S.scanner = null; }
  hideToast();
  S.screen = screen;
  render();
  if (!opts.keepScroll) window.scrollTo(0, 0);
}

async function render() {
  const sc = S.screen;
  $tabs.hidden = !TAB_SCREENS.includes(sc);
  document.body.classList.toggle('has-tabs', TAB_SCREENS.includes(sc));
  $tabs.querySelectorAll('[data-tab]').forEach(b => {
    const on = b.dataset.tab === sc;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const fn = SCREENS[sc] || SCREENS.today;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    $view.innerHTML = `<section class="screen"><h1>Something went wrong</h1><p class="lede">${esc(e.message || e)}</p><button class="btn primary" data-act="tab" data-tab="today">Back to Today</button></section>`;
  }
}

function topBar(title, backLabel = 'Back', backAct = 'back') {
  return `<header class="topbar">
    <button class="link-btn back" data-act="${backAct}">${icon.back(22)}<span>${esc(backLabel)}</span></button>
    <h1 class="topbar-title">${esc(title)}</h1>
    <span class="topbar-spacer"></span>
  </header>`;
}

// ── Busy overlay, toasts, dialogs ──────────────────────────────
function busy(message, sub = '', onCancel = null) {
  $busy.innerHTML = `<div class="busy-card" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <p class="busy-msg">${esc(message)}</p>
    ${sub ? `<p class="busy-sub">${esc(sub)}</p>` : ''}
    ${onCancel ? '<button class="btn secondary" data-busy-cancel>Cancel</button>' : ''}
  </div>`;
  $busy.hidden = false;
  const btn = $busy.querySelector('[data-busy-cancel]');
  if (btn) btn.onclick = onCancel;
}
function unbusy() { $busy.hidden = true; $busy.innerHTML = ''; }

let toastTimer = null;
function toast(message, action = null, ms = 4500) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  $toast.hidden = false;
  $toast.classList.add('show');
  if (action) $toast.querySelector('.toast-btn').onclick = () => { hideToast(); action.run(); };
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $toast.classList.remove('show'); $toast.hidden = true; }

// dialog({ title, message, input?, buttons: [{ label, value, kind }] }) → Promise<{ value, text }>
function dialog({ title, message = '', input = null, buttons }) {
  return new Promise(resolve => {
    $modal.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 id="dlg-title">${esc(title)}</h2>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${input ? `<input class="field" id="dlg-input" type="text" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
      <div class="dialog-btns">${buttons.map((b, i) => `<button class="btn ${b.kind || 'secondary'}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    $modal.hidden = false;
    const inp = $modal.querySelector('#dlg-input');
    if (inp) setTimeout(() => inp.focus(), 50);
    $modal.querySelectorAll('[data-i]').forEach(b => {
      b.onclick = () => {
        const btn = buttons[Number(b.dataset.i)];
        const text = inp ? inp.value : '';
        $modal.hidden = true;
        $modal.innerHTML = '';
        resolve({ value: btn.value, text });
      };
    });
  });
}
const confirmDialog = (title, message, yes, kind = 'danger') =>
  dialog({ title, message, buttons: [{ label: yes, value: true, kind }, { label: 'Cancel', value: false }] }).then(r => r.value);

// ── Screens ────────────────────────────────────────────────────
const SCREENS = {};

// TODAY ─────────────────────────────────────────────────────────
SCREENS.today = async () => {
  if (S.followToday) S.viewDate = dateKey();
  const key = S.viewDate;
  const isToday = key === dateKey();
  const entries = (await db.entriesOn(key)).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const totals = sumEntries(entries);
  const goals = macroGoals();
  const flags = getFlags();
  const showInstall = isIOS() && !isStandalone() && !flags.installDismissed;

  const groups = MEALS.map(m => ({ ...m, entries: entries.filter(e => e.meal === m.id) })).filter(g => g.entries.length);

  $view.innerHTML = `<section class="screen today">
    ${showInstall ? installCard() : ''}
    <header class="day-head">
      <button class="icon-btn" data-act="day-prev" aria-label="Previous day">${icon.back(26)}</button>
      <div class="day-title">
        <h1>${esc(isToday ? 'Today' : dayLabel(key))}</h1>
        <p>${esc(isToday ? niceDate(key) : parseDateKey(key).getFullYear() !== new Date().getFullYear() ? niceDate(key, true) : '')}</p>
      </div>
      <button class="icon-btn" data-act="day-next" aria-label="Next day" ${isToday ? 'disabled' : ''}>${icon.next(26)}</button>
    </header>
    ${!isToday ? '<button class="link-btn center" data-act="day-today">Go to today</button>' : ''}
    ${ringHTML(totals.kcal, goals.kcal)}
    <div class="macros">
      ${macroBar('Protein', totals.protein, goals.protein, 'protein')}
      ${macroBar('Carbs', totals.carbs, goals.carbs, 'carbs')}
      ${macroBar('Fat', totals.fat, goals.fat, 'fat')}
    </div>
    <button class="btn primary big" data-act="go-add">${icon.plus(26)}<span>Add food</span></button>
    ${groups.length ? groups.map(g => `
      <section class="meal-group">
        <header class="meal-head"><h2>${esc(g.name)}</h2><span>${fmtInt(sumEntries(g.entries).kcal)} kcal</span></header>
        <ul class="entry-list">${g.entries.map(entryRow).join('')}</ul>
      </section>`).join('') : `
      <div class="empty">
        <p>${isToday ? 'Nothing logged yet today.' : 'Nothing was logged on this day.'}</p>
        <p class="muted">Tap Add food to take a photo, type what you ate, or scan a barcode.</p>
      </div>`}
  </section>`;
};

function installCard() {
  return `<aside class="install-card">
    <h2>Put Thali on your Home Screen</h2>
    <ol>
      <li>Tap the Share button ${icon.share(20)} at the bottom of Safari.</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      <li>Open Thali from the new icon from now on.</li>
    </ol>
    <p class="muted">Do this before you start logging. Food logged here in Safari stays in Safari and won’t appear in the Home Screen app.</p>
    <button class="link-btn" data-act="dismiss-install">Hide this</button>
  </aside>`;
}

function ringHTML(eaten, goal) {
  const r = 96, c = 2 * Math.PI * r;
  const frac = goal > 0 ? eaten / goal : 0;
  const over = eaten > goal && goal > 0;
  const shown = Math.min(frac, 1);
  const left = Math.round(goal - eaten);
  return `<div class="ring-wrap">
    <svg class="ring ${over ? 'over' : ''}" viewBox="0 0 240 240" role="img" aria-label="${fmtInt(eaten)} of ${fmtInt(goal)} calories eaten">
      <circle class="ring-rim" cx="120" cy="120" r="116"/>
      <circle class="ring-track" cx="120" cy="120" r="${r}"/>
      ${shown > 0 ? `<circle class="ring-fill" cx="120" cy="120" r="${r}" stroke-dasharray="${(shown * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 120 120)"/>` : ''}
      <circle class="ring-inner" cx="120" cy="120" r="76"/>
    </svg>
    <div class="ring-text">
      <span class="ring-num">${fmtInt(Math.abs(left))}</span>
      <span class="ring-label">${over ? 'kcal over' : 'kcal left'}</span>
    </div>
  </div>
  <p class="ring-sub"><strong>${fmtInt(eaten)}</strong> eaten of ${fmtInt(goal)} kcal</p>`;
}

function macroBar(label, value, goal, cls) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  return `<div class="macro ${cls}">
    <div class="macro-top"><span>${label}</span><span><strong>${fmtG(value)}</strong>${goal > 0 ? ` of ${fmtInt(goal)}` : ''} g</span></div>
    <div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
  </div>`;
}

function sourceIcon(source) {
  if (source === 'photo') return icon.camera(24);
  if (source === 'barcode') return icon.barcode(24);
  if (source === 'saved') return icon.saved(24);
  return icon.type(24);
}

function entryRow(e) {
  const t = sumItems(e.items);
  return `<li><button class="entry" data-act="open-entry" data-id="${esc(e.id)}">
    ${e.thumb ? `<img class="thumb" src="${e.thumb}" alt="">` : `<span class="thumb ph">${sourceIcon(e.source)}</span>`}
    <span class="entry-main"><span class="entry-title">${esc(e.title || titleFromItems(e.items))}</span><span class="entry-sub">${esc(timeOf(e.createdAt))}</span></span>
    <span class="entry-kcal">${fmtInt(t.kcal)}<small> kcal</small></span>
  </button></li>`;
}

// ADD ───────────────────────────────────────────────────────────
SCREENS.add = async () => {
  const hasKey = !!getApiKey();
  const offline = navigator.onLine === false;
  $view.innerHTML = `<section class="screen add">
    <h1>Add food</h1>
    <p class="lede">Adding to ${esc(MEAL_SINGULAR[mealForTime()])}. You can change this before saving.</p>
    ${offline ? `<div class="notice">${icon.wifiOff(22)}<p>You’re offline. Photo and typed estimates need the internet. Saved meals and barcodes you’ve scanned before still work.</p></div>` : ''}
    ${!hasKey ? `<div class="notice"><p>Photo and typed estimates need a Claude API key. <button class="link-btn inline" data-act="tab" data-tab="settings">Add it in Settings</button></p></div>` : ''}
    <button class="btn primary hero" data-act="take-photo">${icon.camera(40)}<span>Take a photo</span></button>
    <div class="option-list">
      <button class="btn option" data-act="choose-photo">${icon.image(28)}<span>Choose from Photos</span></button>
      <button class="btn option" data-act="go-text">${icon.type(28)}<span>Type what you ate</span></button>
      <button class="btn option" data-act="go-scan">${icon.barcode(28)}<span>Scan a barcode</span></button>
      <button class="btn option" data-act="tab" data-tab="saved">${icon.saved(28)}<span>Pick a saved meal</span></button>
    </div>
    <p class="fineprint">Estimates for home-cooked food are approximate. The amount of ghee or oil and the portion size are the biggest unknowns, so check them before saving.</p>
  </section>`;
};

// PHOTO PREVIEW ─────────────────────────────────────────────────
SCREENS.photo = async () => {
  if (!S.photo) return go('add');
  $view.innerHTML = `<section class="screen">
    ${topBar('Your photo', 'Cancel', 'cancel-photo')}
    <img class="preview" src="${S.photo.dataUrl}" alt="Your food photo">
    <label class="field-label" for="photo-note">Anything Claude should know? (optional)</label>
    <textarea id="photo-note" class="field" rows="3" maxlength="300" data-bind="photoNote" placeholder="For example: dal made with ghee, 1 katori. 2 phulkas.">${esc(S.photoNote)}</textarea>
    <button class="btn primary big" data-act="estimate-photo">Estimate calories</button>
    <button class="btn secondary" data-act="take-photo">Retake photo</button>
  </section>`;
};

// TEXT ──────────────────────────────────────────────────────────
SCREENS.text = async () => {
  $view.innerHTML = `<section class="screen">
    ${topBar('Type what you ate', 'Cancel', 'cancel-text')}
    <label class="field-label" for="meal-text">What did you eat, and how much?</label>
    <textarea id="meal-text" class="field big-text" rows="5" maxlength="500" data-bind="textInput" placeholder="For example: 2 rotis, dal tadka, a bowl of rajma">${esc(S.textInput)}</textarea>
    <p class="muted small">Add amounts if you know them, like “1 katori” or “2 idlis”, and say if something was made with ghee.</p>
    <button class="btn primary big" data-act="estimate-text">Estimate calories</button>
  </section>`;
  const ta = document.getElementById('meal-text');
  if (ta && !S.textInput) setTimeout(() => ta.focus(), 100);
};

// REVIEW / EDIT ─────────────────────────────────────────────────
const CONF_TEXT = {
  high: ['good', 'Claude is fairly sure about this one.'],
  medium: ['medium', 'Claude is moderately sure. Check the amounts.'],
  low: ['low', 'This is a rough guess. Please check the dishes and amounts.'],
};

SCREENS.review = async () => {
  const d = S.draft;
  if (!d) return go('today');
  const titles = { new: 'Check and save', edit: 'Edit entry', saved: 'Edit saved meal' };
  const isSaved = d.mode === 'saved';
  const canRecheck = d.aiInput && d.model !== CONFIG.MODELS.accurate && d.mode === 'new';
  const today = dateKey();

  $view.innerHTML = `<section class="screen review">
    ${topBar(titles[d.mode], 'Cancel', 'cancel-review')}
    ${d.thumb ? `<img class="review-photo" src="${d.thumb}" alt="">` : ''}
    ${isSaved ? `<label class="field-label" for="saved-name">Name</label>
      <input id="saved-name" class="field" data-bind="name" value="${esc(d.name)}" maxlength="60" autocomplete="off">` : ''}
    ${d.confidence ? `<div class="ai-box conf-${d.confidence}">
        <p class="conf"><span class="dot"></span>${esc(CONF_TEXT[d.confidence][1])}</p>
        ${d.aiNote ? `<p class="ai-note">${esc(d.aiNote)}</p>` : ''}
        ${d.model ? `<p class="muted small">Estimated by ${esc(modelName(d.model))}.</p>` : ''}
      </div>` : ''}
    ${d.productInfo ? `<p class="product-info">${esc(d.productInfo)}</p>` : ''}
    <div id="items">${d.items.map((it, i) => itemCard(it, i)).join('')}</div>
    <button class="btn secondary" data-act="add-item">${icon.plus(22)}<span>Add another item</span></button>
    ${canRecheck ? `<button class="btn secondary recheck" data-act="recheck">${icon.refresh(22)}<span>Re-check with more accurate model</span></button>
      <p class="muted small center">Uses ${esc(modelName(CONFIG.MODELS.accurate))}, which costs about twice as much per estimate.</p>` : ''}
    ${!isSaved ? `
      <h2 class="section-title">Meal</h2>
      <div class="segmented" role="group" aria-label="Meal">
        ${MEALS.map(m => `<button data-act="set-meal" data-meal="${m.id}" aria-pressed="${d.meal === m.id}">${m.name}</button>`).join('')}
      </div>
      <label class="field-label" for="draft-date">Day</label>
      <input id="draft-date" class="field" type="date" data-bind="date" value="${esc(d.date)}" max="${today}">
      ${d.mode === 'new' ? `
        <label class="check"><input type="checkbox" data-bind="favourite" ${d.favourite ? 'checked' : ''}><span>Also save to Saved meals</span></label>
        <div class="fav-name" ${d.favourite ? '' : 'hidden'}>
          <label class="field-label" for="fav-name">Name for this saved meal</label>
          <input id="fav-name" class="field" data-bind="favName" value="${esc(d.favName || '')}" placeholder="${esc(titleFromItems(d.items))}" maxlength="60" autocomplete="off">
        </div>` : ''}
      ${d.barcode && d.productSource !== 'off' ? `
        <label class="check"><input type="checkbox" data-bind="rememberProduct" ${d.rememberProduct ? 'checked' : ''}><span>Remember this product for barcode ${esc(d.barcode)}, so it’s instant next time</span></label>` : ''}
    ` : ''}
    ${d.source === 'photo' || d.source === 'text' ? '<p class="fineprint">Estimates for home-cooked food are approximate. Ghee or oil and portion size are the biggest unknowns.</p>' : ''}
    ${d.mode === 'edit' ? `<button class="btn danger-outline" data-act="delete-entry">${icon.trash(22)}<span>Delete this entry</span></button>` : ''}
    ${d.mode === 'saved' ? `<button class="btn danger-outline" data-act="saved-delete" data-id="${esc(d.savedId)}">${icon.trash(22)}<span>Delete saved meal</span></button>` : ''}
    <div class="sticky-foot">
      <p class="total" id="draft-total">${totalLine(d.items)}</p>
      <button class="btn primary big" data-act="save-draft">${d.mode === 'new' ? 'Add to log' : 'Save changes'}</button>
    </div>
  </section>`;
};

function totalLine(items) {
  const t = sumItems(items);
  return `<strong>Total ${fmtInt(t.kcal)}&nbsp;kcal</strong><span>Protein ${fmtG(t.protein)}&nbsp;g, carbs ${fmtG(t.carbs)}&nbsp;g, fat ${fmtG(t.fat)}&nbsp;g</span>`;
}

function itemCard(it, i) {
  const t = itemTotals(it);
  const u = it.unit || 'g';
  const editing = it._edit || (it.per100 && !it.kcal) || (!it.per100 && !t.kcal && !it.name);
  const removeBtn = `<button class="link-btn danger" data-act="remove-item" data-i="${i}">${icon.trash(18)}<span>Remove</span></button>`;
  if (it.per100) {
    const chips = [];
    if (it.servingG > 0) {
      chips.push([it.servingG, `1 serving (${fmtG(it.servingG)} ${u})`]);
      chips.push([it.servingG * 2, '2 servings']);
    }
    chips.push([100, `100 ${u}`]);
    return `<div class="item" data-i="${i}">
      <label class="sr-only" for="name-${i}">Name</label>
      <input id="name-${i}" class="field item-name" data-bind="name" data-i="${i}" value="${esc(it.name)}" placeholder="Product name" maxlength="80" autocomplete="off">
      <div class="amount-row">
        <label for="eaten-${i}">Amount eaten</label>
        <span class="unit-input"><input id="eaten-${i}" class="field num" inputmode="decimal" data-bind="eaten" data-i="${i}" value="${fmtG(t.grams).replace(/,/g, '')}"><span>${u}</span></span>
      </div>
      <div class="chips">${chips.map(([g, l]) => `<button class="chip" data-act="grams-chip" data-i="${i}" data-g="${g}">${esc(l)}</button>`).join('')}</div>
      <p class="ate" data-ate="${i}">${ateLine(it)}</p>
      <div class="per100" ${editing ? 'hidden' : ''} data-sum="${i}">
        <p class="muted small">Per 100 ${u}: <span data-sumtext>${per100Line(it)}</span></p>
        <button class="link-btn" data-act="edit-nums" data-i="${i}">Change numbers</button>
      </div>
      <div class="nums-wrap" ${editing ? '' : 'hidden'} data-nums="${i}">
        <p class="sub-label">Per 100 ${u}, from the pack</p>
        <div class="nums">
          ${numField(i, 'kcal', 'Calories', it.kcal, 'kcal')}
          ${numField(i, 'protein', 'Protein', it.protein, 'g')}
          ${numField(i, 'carbs', 'Carbs', it.carbs, 'g')}
          ${numField(i, 'fat', 'Fat', it.fat, 'g')}
        </div>
      </div>
      ${removeBtn}
    </div>`;
  }
  return `<div class="item" data-i="${i}">
    <label class="sr-only" for="name-${i}">Dish name</label>
    <input id="name-${i}" class="field item-name" data-bind="name" data-i="${i}" value="${esc(it.name)}" placeholder="Dish name" maxlength="80" autocomplete="off">
    <label class="sr-only" for="portion-${i}">Portion description</label>
    <input id="portion-${i}" class="field portion" data-bind="portion" data-i="${i}" value="${esc(it.portion)}" placeholder="Portion, e.g. 1 katori" maxlength="80" autocomplete="off">
    <div class="amount-row">
      <div class="stepper" role="group" aria-label="Portion size">
        <button data-act="qty-minus" data-i="${i}" aria-label="Smaller portion">${icon.minus(24)}</button>
        <output data-qty="${i}" aria-live="polite">×${qtyLabel(it.qty)}</output>
        <button data-act="qty-plus" data-i="${i}" aria-label="Bigger portion">${icon.plus(24)}</button>
      </div>
      <span class="unit-input"><input class="field num" inputmode="decimal" data-bind="eaten" data-i="${i}" value="${t.grams ? fmtG(t.grams).replace(/,/g, '') : ''}" placeholder="0" aria-label="Grams eaten"><span>g</span></span>
    </div>
    <div class="item-sum" ${editing ? 'hidden' : ''} data-sum="${i}">
      <p data-sumtext>${itemSumLine(it)}</p>
      <button class="link-btn" data-act="edit-nums" data-i="${i}">Change numbers</button>
    </div>
    <div class="nums-wrap" ${editing ? '' : 'hidden'} data-nums="${i}">
      <div class="nums">
        ${numField(i, 'kcal', 'Calories', t.kcal, 'kcal')}
        ${numField(i, 'protein', 'Protein', t.protein, 'g')}
        ${numField(i, 'carbs', 'Carbs', t.carbs, 'g')}
        ${numField(i, 'fat', 'Fat', t.fat, 'g')}
      </div>
    </div>
    ${removeBtn}
  </div>`;
}

function itemSumLine(it) {
  const t = itemTotals(it);
  return `<strong>${fmtInt(t.kcal)}&nbsp;kcal</strong> <span class="muted">protein ${fmtG(t.protein)}&nbsp;g, carbs ${fmtG(t.carbs)}&nbsp;g, fat ${fmtG(t.fat)}&nbsp;g</span>`;
}
function per100Line(it) {
  return `${fmtInt(it.kcal)}&nbsp;kcal, protein ${fmtG(it.protein)}&nbsp;g, carbs ${fmtG(it.carbs)}&nbsp;g, fat ${fmtG(it.fat)}&nbsp;g`;
}

function numField(i, key, label, value, unit) {
  const v = key === 'kcal' ? fmtInt(value).replace(/,/g, '') : fmtG(value).replace(/,/g, '');
  return `<label class="num-field"><span>${label}</span><span class="unit-input"><input class="field num" inputmode="decimal" data-bind="${key}" data-i="${i}" value="${v}"><span>${unit}</span></span></label>`;
}

function ateLine(it) {
  const t = itemTotals(it);
  return `You ate <strong>${fmtInt(t.kcal)}&nbsp;kcal</strong>: protein ${fmtG(t.protein)}&nbsp;g, carbs ${fmtG(t.carbs)}&nbsp;g, fat ${fmtG(t.fat)}&nbsp;g`;
}

// Updates the numbers of one item without redrawing (keeps the keyboard open).
function refreshItem(i, skip) {
  const it = S.draft.items[i];
  const card = $view.querySelector(`.item[data-i="${i}"]`);
  if (!it || !card) return;
  const t = itemTotals(it);
  const set = (bind, val) => {
    const el = card.querySelector(`[data-bind="${bind}"]`);
    if (el && el !== skip) el.value = val;
  };
  const sum = card.querySelector('[data-sumtext]');
  if (it.per100) {
    set('eaten', fmtG(t.grams).replace(/,/g, ''));
    const ate = card.querySelector('[data-ate]');
    if (ate) ate.innerHTML = ateLine(it);
    if (sum) sum.innerHTML = per100Line(it);
  } else {
    if (sum) sum.innerHTML = itemSumLine(it);
    set('eaten', t.grams ? fmtG(t.grams).replace(/,/g, '') : '');
    set('kcal', fmtInt(t.kcal).replace(/,/g, ''));
    set('protein', fmtG(t.protein).replace(/,/g, ''));
    set('carbs', fmtG(t.carbs).replace(/,/g, ''));
    set('fat', fmtG(t.fat).replace(/,/g, ''));
    const out = card.querySelector('[data-qty]');
    if (out) out.textContent = `×${qtyLabel(it.qty)}`;
  }
  const tot = document.getElementById('draft-total');
  if (tot) tot.innerHTML = totalLine(S.draft.items);
}

// SCAN ──────────────────────────────────────────────────────────
SCREENS.scan = async () => {
  if (S.scanner) { S.scanner.stop(); S.scanner = null; }
  const live = cameraSupported();
  $view.innerHTML = `<section class="screen scan">
    ${topBar('Scan a barcode', 'Back', 'back-add')}
    <div id="cam-area" class="cam-area">${live && !S.scanError ? `
      <div class="viewfinder">
        <video id="scan-video" playsinline muted autoplay></video>
        <div class="guide" aria-hidden="true"></div>
      </div>
      <p class="muted center" id="scan-status">Starting the camera…</p>` : camErrorHTML(live)}</div>
    <button class="btn primary" data-act="scan-photo">${icon.camera(24)}<span>Take a photo of the barcode instead</span></button>
    <h2 class="section-title">Or type the number</h2>
    <div class="type-code">
      <input id="typed-code" class="field num" inputmode="numeric" pattern="[0-9]*" data-bind="typedCode" value="${esc(S.typedCode)}" placeholder="e.g. 9300633603373" maxlength="14" autocomplete="off" aria-label="Barcode number">
      <button class="btn primary" data-act="lookup-typed">Look up</button>
    </div>
    <p class="muted small">The number is printed under the barcode lines.</p>
  </section>`;
  if (live && !S.scanError) startScanner();
};

async function startScanner() {
  const video = document.getElementById('scan-video');
  const status = document.getElementById('scan-status');
  if (!video) return;
  const scanner = new LiveScanner(video, code => handleBarcode(code));
  S.scanner = scanner;
  try {
    await scanner.start();
    if (status && S.scanner === scanner) status.textContent = 'Point at the barcode and hold steady, about a hand’s length away.';
  } catch (e) {
    scanner.stop();
    if (S.scanner === scanner) S.scanner = null;
    if (S.screen === 'scan') {
      S.scanError = cameraErrorMessage(e);
      // Only swap the camera box, so anything typed below stays put.
      const area = document.getElementById('cam-area');
      if (area) area.innerHTML = camErrorHTML(true);
    }
  }
}

function camErrorHTML(live) {
  return `<div class="notice"><p>${esc(S.scanError || 'The live camera isn’t available here.')}</p></div>
    ${live ? '<button class="btn secondary" data-act="retry-camera">Try the camera again</button>' : ''}`;
}

async function handleBarcode(raw) {
  const code = cleanBarcode(raw);
  if (code.length < 6) { toast('That number is too short for a product barcode.'); return; }
  if (S.scanner) { S.scanner.stop(); S.scanner = null; }
  if (!checksumOk(code) && code.length >= 8) {
    const ok = await confirmDialog('Check the number', `${code} doesn’t look like a valid barcode. Look it up anyway?`, 'Look it up', 'primary');
    if (!ok) { if (S.screen === 'scan') render(); return; }
  }
  busy('Looking up the barcode…');
  try {
    const remembered = await findRemembered(code);
    if (remembered) { unbusy(); return openProduct(remembered, remembered.source || 'manual', true); }
    const r = await lookupOFF(code);
    unbusy();
    if (r.status === 'found') {
      await rememberProduct(r.product); // so it works offline next time
      return openProduct(r.product, 'off');
    }
    S.notFound = { code, status: r.status, product: r.product || null };
    go('notfound');
  } catch (e) {
    unbusy();
    S.notFound = { code, status: 'error', error: e.message };
    go('notfound');
  }
}

function openProduct(p, source, remembered = false) {
  const servingG = nonNeg(p.servingG);
  const eaten = servingG > 0 ? servingG : 100;
  const item = makeItem({
    name: [p.name, p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `(${p.brand})` : ''].filter(Boolean).join(' '),
    grams: 100,
    kcal: p.per100.kcal, protein: p.per100.protein, carbs: p.per100.carbs, fat: p.per100.fat,
    qty: eaten / 100, per100: true, servingG, unit: p.unit,
  });
  S.draft = newDraft({
    source: 'barcode',
    items: [item],
    barcode: p.barcode,
    productSource: source,
    rememberProduct: source !== 'off',
    product: { name: p.name, brand: p.brand, servingDesc: p.servingDesc || '' },
    productInfo: remembered
      ? (source === 'off' ? 'From Open Food Facts, remembered on this phone.' : 'Remembered on this phone from an earlier scan.')
      : source === 'off' ? 'From Open Food Facts. Check the numbers against the pack if you can.'
        : source === 'ai' ? 'Read from your label photo.' : '',
  });
  go('review');
}

// NOT FOUND ─────────────────────────────────────────────────────
SCREENS.notfound = async () => {
  const nf = S.notFound;
  if (!nf) return go('add');
  const head = nf.status === 'no_nutrition'
    ? `Found “${esc(nf.product?.name || 'this product')}”, but it has no nutrition information yet.`
    : nf.status === 'error' ? esc(nf.error) : `Barcode ${esc(nf.code)} isn’t in Open Food Facts yet.`;
  $view.innerHTML = `<section class="screen">
    ${topBar('Product not found', 'Back', 'back-scan')}
    <p class="lede">${head}</p>
    <button class="btn primary big" data-act="label-photo">${icon.camera(26)}<span>Photograph the label or pack</span></button>
    <p class="muted small">Claude reads the nutrition panel (or estimates from the pack) and the result is remembered for this barcode.</p>
    <button class="btn secondary" data-act="manual-product">${icon.type(24)}<span>Type the numbers from the pack</span></button>
    ${nf.status === 'error' ? '<button class="btn secondary" data-act="retry-lookup">Try the lookup again</button>' : ''}
    <button class="btn secondary" data-act="back-scan">Scan a different barcode</button>
  </section>`;
};

// LABEL PHOTO PREVIEW ───────────────────────────────────────────
SCREENS.label = async () => {
  if (!S.labelPhoto) return go('notfound');
  $view.innerHTML = `<section class="screen">
    ${topBar('Label photo', 'Back', 'back-notfound')}
    <img class="preview" src="${S.labelPhoto.dataUrl}" alt="Photo of the pack">
    <p class="muted small">Best: the nutrition panel, flat and in focus. The front of the pack works too, but the numbers will be a guess.</p>
    <label class="field-label" for="label-note">Anything to add? (optional)</label>
    <input id="label-note" class="field" data-bind="labelNote" value="${esc(S.labelNote)}" placeholder="e.g. Haldiram’s bhujia, 200 g pack" maxlength="200" autocomplete="off">
    <button class="btn primary big" data-act="read-label">Read the label</button>
    <button class="btn secondary" data-act="label-photo">Retake photo</button>
  </section>`;
};

// SAVED MEALS ───────────────────────────────────────────────────
SCREENS.saved = async () => {
  const list = (await db.all('saved')).sort((a, b) => (b.lastUsed || b.createdAt || '').localeCompare(a.lastUsed || a.createdAt || ''));
  const meal = mealForTime();
  $view.innerHTML = `<section class="screen saved">
    <h1>Saved meals</h1>
    ${list.length ? `<p class="lede">Tap Add to log a meal to today’s ${esc(MEAL_SINGULAR[meal])}. Tap a name to change the portion, edit or delete it.</p>
      <ul class="saved-list">${list.map(s => {
        const t = sumItems(s.items);
        return `<li class="saved-row">
          <button class="saved-main" data-act="open-saved" data-id="${esc(s.id)}">
            ${s.thumb ? `<img class="thumb" src="${s.thumb}" alt="">` : `<span class="thumb ph">${sourceIcon(s.source)}</span>`}
            <span class="entry-main"><span class="entry-title">${esc(s.name)}</span><span class="entry-sub">${fmtInt(t.kcal)} kcal</span></span>
          </button>
          <button class="btn primary add-btn" data-act="quick-log" data-id="${esc(s.id)}" aria-label="Add ${esc(s.name)}">Add</button>
        </li>`;
      }).join('')}</ul>` : `
      <div class="empty">
        <p>No saved meals yet.</p>
        <p class="muted">When you add food, tick “Also save to Saved meals”. It will appear here so you can log it again with one tap.</p>
      </div>
      <button class="btn primary big" data-act="go-add">${icon.plus(26)}<span>Add food</span></button>`}
  </section>`;
};

SCREENS.savedDetail = async () => {
  const s = await db.get('saved', S.savedId);
  if (!s) return go('saved');
  const f = S.savedFactor;
  const meal = S.savedMeal || mealForTime();
  const scaled = s.items.map(it => ({ ...it, qty: it.qty * f }));
  const t = sumItems(scaled);
  $view.innerHTML = `<section class="screen">
    ${topBar(s.name, 'Back', 'back-saved')}
    ${s.thumb ? `<img class="review-photo" src="${s.thumb}" alt="">` : ''}
    <ul class="plain-list">${s.items.map(it => `<li>${esc(it.name)}${it.portion ? ` <span class="muted">${esc(it.portion)}</span>` : ''}</li>`).join('')}</ul>
    <h2 class="section-title">How much?</h2>
    <div class="segmented" role="group" aria-label="Portion">
      ${[0.5, 1, 1.5, 2].map(x => `<button data-act="saved-factor" data-f="${x}" aria-pressed="${f === x}">${x === 1 ? 'Usual' : '×' + qtyLabel(x)}</button>`).join('')}
    </div>
    <p class="total big-total"><strong>${fmtInt(t.kcal)} kcal</strong><span>Protein ${fmtG(t.protein)} g, carbs ${fmtG(t.carbs)} g, fat ${fmtG(t.fat)} g</span></p>
    <h2 class="section-title">Meal</h2>
    <div class="segmented" role="group" aria-label="Meal">
      ${MEALS.map(m => `<button data-act="saved-meal" data-meal="${m.id}" aria-pressed="${meal === m.id}">${m.name}</button>`).join('')}
    </div>
    <button class="btn primary big" data-act="saved-log" data-id="${esc(s.id)}">Add to today</button>
    <div class="row-btns">
      <button class="btn secondary" data-act="saved-edit" data-id="${esc(s.id)}">Edit</button>
      <button class="btn secondary" data-act="saved-rename" data-id="${esc(s.id)}">Rename</button>
    </div>
    <button class="btn danger-outline" data-act="saved-delete" data-id="${esc(s.id)}">${icon.trash(22)}<span>Delete</span></button>
  </section>`;
};

async function logSaved(id, factor, meal) {
  const s = await db.get('saved', id);
  if (!s) return;
  const now = new Date();
  const entry = {
    id: newId(),
    date: dateKey(now),
    createdAt: now.toISOString(),
    meal: meal || mealForTime(now),
    title: s.name,
    source: 'saved',
    savedId: s.id,
    items: s.items.map(it => ({ ...it, qty: it.qty * factor })),
    thumb: s.thumb || null,
    note: '', aiNote: '', confidence: null, model: null, barcode: s.barcode || null,
  };
  await db.put('entries', entry);
  await db.put('saved', { ...s, lastUsed: now.toISOString(), useCount: (s.useCount || 0) + 1 });
  return entry;
}

// HISTORY ───────────────────────────────────────────────────────
SCREENS.history = async () => {
  const n = S.historyDays;
  const today = dateKey();
  const from = addDays(today, -(n - 1));
  const entries = await db.entriesBetween(from, today);
  const goal = macroGoals().kcal;
  const days = [];
  for (let i = 0; i < n; i++) {
    const key = addDays(today, -i);
    const es = entries.filter(e => e.date === key);
    days.push({ key, count: es.length, t: sumEntries(es) });
  }
  const logged = days.filter(d => d.count);
  const avg = logged.length ? logged.reduce((a, d) => a + d.t.kcal, 0) / logged.length : 0;
  const maxK = Math.max(goal * 1.25, ...days.map(d => d.t.kcal), 1);
  const chartDays = [...days].reverse();

  $view.innerHTML = `<section class="screen history">
    <h1>History</h1>
    <div class="segmented" role="group" aria-label="Range">
      <button data-act="range" data-n="7" aria-pressed="${n === 7}">Last 7 days</button>
      <button data-act="range" data-n="30" aria-pressed="${n === 30}">Last 30 days</button>
    </div>
    ${logged.length ? `
      <p class="lede">Average <strong>${fmtInt(avg)} kcal</strong> a day on the ${logged.length} ${logged.length === 1 ? 'day' : 'days'} you logged food. Goal ${fmtInt(goal)} kcal.</p>
      <div class="chart ${n === 30 ? 'dense' : ''}" role="img" aria-label="Calories per day">
        <span class="goal-line" style="bottom:${((goal / maxK) * 100).toFixed(1)}%"></span>
        ${chartDays.map(d => `<span class="col" title="${esc(shortDate(d.key))}: ${fmtInt(d.t.kcal)} kcal"><span class="b ${d.t.kcal > goal ? 'over' : ''}" style="height:${((d.t.kcal / maxK) * 100).toFixed(1)}%"></span></span>`).join('')}
      </div>
      ${n === 7 ? `<div class="chart-labels" aria-hidden="true">${chartDays.map(d => `<span>${esc(parseDateKey(d.key).toLocaleDateString('en-AU', { weekday: 'short' }))}</span>`).join('')}</div>` : ''}
      <p class="chart-key muted small"><span class="key-line"></span> Daily goal</p>` : '<div class="empty"><p>No food logged in this period yet.</p></div>'}
    <ul class="day-list">${days.map(d => `<li><button class="day-row" data-act="open-day" data-date="${d.key}">
      <span class="day-name">${esc(d.key === today ? 'Today' : shortDate(d.key))}</span>
      <span class="day-detail">${d.count ? `<strong>${fmtInt(d.t.kcal)} kcal</strong><span class="muted small">Protein ${fmtG(d.t.protein)} g, carbs ${fmtG(d.t.carbs)} g, fat ${fmtG(d.t.fat)} g</span>` : '<span class="muted">Nothing logged</span>'}</span>
      ${icon.next(20)}
    </button></li>`).join('')}</ul>
  </section>`;
};

// SETTINGS ──────────────────────────────────────────────────────
SCREENS.settings = async () => {
  const st = getSettings();
  const key = getApiKey();
  const goals = macroGoals(st);
  const u = usageSummary();
  const money = v => (v < 0.01 && v > 0 ? 'less than US$0.01' : `about US$${v.toFixed(2)}`);
  let storage = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage) storage = `This app is using about ${(e.usage / 1048576).toFixed(1)} MB on this phone.`;
    }
  } catch { /* ignore */ }
  const masked = key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '';
  // Prepared now so the share sheet can open straight away when the button is tapped.
  S.exportReady = exportAll().catch(() => null);

  $view.innerHTML = `<section class="screen settings">
    <h1>Settings</h1>

    <section class="card">
      <h2>Claude API key</h2>
      ${key ? `<p>Key saved on this phone: <span class="mono">${esc(masked)}</span></p>` : '<p>Needed for photo and typed estimates. Barcodes and saved meals work without it.</p>'}
      <label class="field-label" for="api-key">${key ? 'Replace key' : 'Paste your key'}</label>
      <input id="api-key" class="field" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-…">
      <div class="row-btns">
        <button class="btn primary" data-act="save-key">Save key</button>
        <button class="btn secondary" data-act="show-key">Show</button>
      </div>
      ${key ? `<div class="row-btns">
        <button class="btn secondary" data-act="test-key">Test key</button>
        <button class="btn secondary danger-text" data-act="remove-key">Remove key</button>
      </div>` : ''}
      <p class="muted small">The key stays on this phone and is only sent to Anthropic. Anyone holding this phone could see it, so set a monthly spend limit in the Anthropic Console.</p>
    </section>

    <section class="card">
      <h2>Daily goals</h2>
      <label class="field-label" for="goal-kcal">Calories (kcal)</label>
      <input id="goal-kcal" class="field num" inputmode="numeric" data-setting="calorieGoal" value="${st.calorieGoal}">
      <p class="field-label">Protein, carbs and fat targets</p>
      <div class="segmented" role="group" aria-label="Macro targets">
        <button data-act="macro-mode" data-mode="auto" aria-pressed="${st.macroMode !== 'custom'}">Automatic</button>
        <button data-act="macro-mode" data-mode="custom" aria-pressed="${st.macroMode === 'custom'}">My own</button>
      </div>
      ${st.macroMode === 'custom' ? `
        <div class="nums">
          <label class="num-field"><span>Protein</span><span class="unit-input"><input class="field num" inputmode="numeric" data-setting="proteinGoal" value="${st.proteinGoal || goals.protein}"><span>g</span></span></label>
          <label class="num-field"><span>Carbs</span><span class="unit-input"><input class="field num" inputmode="numeric" data-setting="carbsGoal" value="${st.carbsGoal || goals.carbs}"><span>g</span></span></label>
          <label class="num-field"><span>Fat</span><span class="unit-input"><input class="field num" inputmode="numeric" data-setting="fatGoal" value="${st.fatGoal || goals.fat}"><span>g</span></span></label>
        </div>` : `
        <p class="muted small">From your calorie goal: protein ${goals.protein} g, carbs ${goals.carbs} g, fat ${goals.fat} g (20%, 50% and 30% of calories).</p>`}
    </section>

    <section class="card">
      <h2>AI use</h2>
      <p>Today: <strong>${u.today.calls}</strong> ${u.today.calls === 1 ? 'request' : 'requests'}${u.today.calls ? `, ${money(u.today.cost)}` : ''}</p>
      <p>This month: <strong>${u.month.calls}</strong> ${u.month.calls === 1 ? 'request' : 'requests'}${u.month.calls ? `, ${money(u.month.cost)}` : ''}</p>
      <p class="muted small">Counted on this phone only, using Anthropic’s published prices. Your real bill is in the Anthropic Console.</p>
      <button class="link-btn" data-act="reset-usage">Reset counter</button>
    </section>

    <section class="card">
      <h2>Backup</h2>
      <p>Your log lives only on this phone. Deleting the app from the Home Screen deletes it too, so save a backup now and then.</p>
      <p class="muted small">${st.lastBackup ? `Last backup: ${esc(new Date(st.lastBackup).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }))}.` : 'No backup saved yet.'} Backups don’t include your API key.</p>
      <button class="btn primary" data-act="export">Save a backup</button>
      <button class="btn secondary" data-act="import">Restore from a backup</button>
    </section>

    <section class="card">
      <h2>About</h2>
      <p class="muted small">Thali ${esc(CONFIG.APP_VERSION)}. Estimates by ${esc(modelName(CONFIG.MODELS.fast))}; re-checks by ${esc(modelName(CONFIG.MODELS.accurate))}. Barcode data from Open Food Facts. ${esc(storage)}</p>
      ${!isStandalone() && isIOS() ? '<button class="btn secondary" data-act="show-install">How to add to Home Screen</button>' : ''}
      <button class="btn secondary" data-act="check-update">Check for updates</button>
      <button class="btn danger-outline" data-act="erase-all">Erase everything on this phone</button>
    </section>
  </section>`;
};

// ── Drafts ─────────────────────────────────────────────────────
function newDraft(extra) {
  return {
    mode: 'new',
    items: [],
    meal: mealForTime(),
    date: dateKey(),
    thumb: null,
    note: '',
    aiNote: '',
    confidence: null,
    model: null,
    favourite: false,
    favName: '',
    barcode: null,
    productSource: null,
    rememberProduct: false,
    product: null,
    productInfo: '',
    aiInput: null,
    ...extra,
  };
}

function draftFromEntry(e) {
  return newDraft({
    mode: 'edit',
    entryId: e.id,
    createdAt: e.createdAt,
    source: e.source,
    title: e.title,
    savedId: e.savedId || null,
    items: e.items.map(makeItem),
    meal: e.meal,
    date: e.date,
    thumb: e.thumb || null,
    note: e.note || '',
    aiNote: e.aiNote || '',
    confidence: e.confidence || null,
    model: e.model || null,
    barcode: e.barcode || null,
    productSource: 'off', // don't offer "remember" again when editing
  });
}

async function saveDraft() {
  const d = S.draft;
  const items = d.items
    .filter(it => it.name.trim() || itemTotals(it).kcal > 0)
    .map(({ _edit, ...it }) => ({ ...it, name: it.name.trim() || 'Food' }));
  if (!items.length) { toast('Add at least one item, or tap Cancel.'); return; }

  if (d.mode === 'saved') {
    const s = await db.get('saved', d.savedId);
    if (!s) return go('saved');
    const name = (d.name || '').trim() || titleFromItems(items);
    await db.put('saved', { ...s, name, items });
    toast('Saved meal updated.');
    S.savedFactor = 1;
    return go('savedDetail');
  }

  const titleOverride = d.source === 'saved' && d.title ? d.title : null;
  const entry = {
    id: d.entryId || newId(),
    date: d.date || dateKey(),
    createdAt: d.createdAt || new Date().toISOString(),
    meal: d.meal,
    title: titleOverride || titleFromItems(items),
    source: d.source,
    savedId: d.savedId || null,
    items,
    thumb: d.thumb || null,
    note: d.note || '',
    aiNote: d.aiNote || '',
    confidence: d.confidence || null,
    model: d.model || null,
    barcode: d.barcode || null,
  };
  await db.put('entries', entry);

  if (d.mode === 'new' && d.favourite) {
    await db.put('saved', {
      id: newId(),
      name: (d.favName || '').trim() || entry.title,
      items: items.map(it => ({ ...it })),
      thumb: entry.thumb,
      source: entry.source,
      barcode: entry.barcode,
      createdAt: new Date().toISOString(),
      useCount: 1,
    });
  }

  if (d.barcode && d.rememberProduct) {
    const it = items.find(x => x.per100);
    if (it) {
      await rememberProduct({
        barcode: d.barcode,
        name: d.product?.name || it.name,
        brand: d.product?.brand || '',
        per100: { kcal: round(it.kcal, 0), protein: round(it.protein, 1), carbs: round(it.carbs, 1), fat: round(it.fat, 1) },
        servingG: it.servingG || 0,
        servingDesc: d.product?.servingDesc || '',
        unit: it.unit || 'g',
        source: d.productSource || 'manual',
      });
    }
  }

  const wasNew = d.mode === 'new';
  S.draft = null;
  S.photo = null; S.photoNote = ''; S.textInput = ''; S.labelPhoto = null; S.labelNote = ''; S.typedCode = '';
  S.viewDate = entry.date;
  S.followToday = entry.date === dateKey();
  go('today');
  toast(wasNew ? `Added to ${MEAL_SINGULAR[entry.meal]}${d.favourite ? ' and Saved meals' : ''}.` : 'Changes saved.');
}

// ── AI flows ───────────────────────────────────────────────────
function aiBusy(message) {
  const ctrl = new AbortController();
  S.aiAbort = ctrl;
  busy(message, 'This usually takes 5 to 20 seconds.', () => ctrl.abort());
  return ctrl.signal;
}

async function aiFailed(e) {
  unbusy();
  if (e.code === 'cancelled') return;
  if (e.code === 'no_key' || e.code === 'bad_key') {
    const r = await dialog({ title: e.code === 'no_key' ? 'API key needed' : 'API key not accepted', message: e.message, buttons: [{ label: 'Go to Settings', value: true, kind: 'primary' }, { label: 'Not now', value: false }] });
    if (r.value) go('settings');
    return;
  }
  await dialog({ title: 'No estimate this time', message: e.message || 'Something went wrong. Try again.', buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
}

async function runMealEstimate(input, model) {
  if (!getApiKey()) return aiFailed(new AIError('no_key', 'Add your Claude API key in Settings first. Barcodes and saved meals work without one.'));
  const signal = aiBusy(model === CONFIG.MODELS.accurate ? 'Re-checking with the more accurate model…' : (input.imageBase64 ? 'Looking at your food…' : 'Working out the calories…'));
  try {
    const res = await estimateMeal({ ...input, model, signal });
    unbusy();
    const r = res.result;
    if (!r.items.length) {
      await dialog({ title: 'No food found', message: r.note || 'Claude couldn’t see any food. Try another photo or type what you ate.', buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
      return;
    }
    const keep = S.draft && S.draft.mode === 'new' && S.draft.aiInput === input ? S.draft : null;
    S.draft = newDraft({
      source: input.imageBase64 ? 'photo' : 'text',
      items: r.items,
      thumb: input.thumb || null,
      note: input.note || input.text || '',
      aiNote: res.truncated ? `The answer was cut short, so check the last item. ${r.note}`.trim() : r.note,
      confidence: res.truncated ? 'low' : r.confidence,
      model: res.model,
      aiInput: input,
      ...(keep ? { meal: keep.meal, date: keep.date, favourite: keep.favourite, favName: keep.favName } : {}),
    });
    go('review');
    if (keep) toast(`Updated by ${modelName(res.model)}.`);
  } catch (e) {
    aiFailed(e);
  }
}

async function runLabelRead(model) {
  if (!getApiKey()) return aiFailed(new AIError('no_key', 'Reading a label needs your Claude API key. Add it in Settings, or type the numbers from the pack instead.'));
  const p = S.labelPhoto;
  const signal = aiBusy('Reading the label…');
  try {
    const res = await readLabel({ imageBase64: p.base64, note: S.labelNote, model, signal });
    unbusy();
    const r = res.result;
    const code = S.labelFor;
    const product = {
      barcode: code,
      name: r.name || S.notFound?.product?.name || 'Product',
      brand: r.brand,
      per100: r.per100,
      servingG: r.servingG,
      servingDesc: r.servingDesc,
      unit: r.unit,
      source: 'ai',
    };
    openProduct(product, 'ai');
    Object.assign(S.draft, {
      aiInput: { kind: 'label' },
      thumb: p.thumb,
      confidence: r.fromLabel ? r.confidence : 'low',
      aiNote: r.fromLabel ? r.note : `No nutrition panel was visible, so these are typical values. ${r.note}`.trim(),
      model: res.model,
      productInfo: r.fromLabel ? 'Read from your label photo. Check against the pack.' : 'Estimated from the pack, not read from a label.',
    });
    render();
  } catch (e) {
    aiFailed(e);
  }
}

// ── File inputs (camera / photo library / import) ──────────────
const inputs = {
  camera: document.getElementById('in-camera'),
  library: document.getElementById('in-library'),
  barcode: document.getElementById('in-barcode'),
  label: document.getElementById('in-label'),
  import: document.getElementById('in-import'),
};

async function preparePhoto(file) {
  const p = await compressPhoto(file, CONFIG.IMAGE_MAX_SIDE, CONFIG.IMAGE_QUALITY);
  return { dataUrl: p.dataUrl, base64: p.base64, thumb: thumbFromCanvas(p.canvas, CONFIG.THUMB_MAX_SIDE, CONFIG.THUMB_QUALITY) };
}

function onFile(input, handler) {
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try { await handler(file); } catch (e) { unbusy(); toast(e.message || 'That file couldn’t be opened.'); }
  });
}

onFile(inputs.camera, async file => {
  busy('Preparing photo…');
  S.photo = await preparePhoto(file);
  unbusy();
  go('photo');
});
onFile(inputs.library, async file => {
  busy('Preparing photo…');
  S.photo = await preparePhoto(file);
  unbusy();
  go('photo');
});
onFile(inputs.barcode, async file => {
  busy('Reading the barcode…');
  let code = null;
  try { code = await decodeFromFile(file); } catch { code = null; }
  unbusy();
  if (code) return handleBarcode(code);
  await dialog({ title: 'No barcode found', message: 'Try again with the barcode filling more of the photo, flat and in good light. Or type the number under the lines.', buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
});
onFile(inputs.label, async file => {
  busy('Preparing photo…');
  S.labelPhoto = await preparePhoto(file);
  unbusy();
  go('label');
});
onFile(inputs.import, async file => {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  const problem = validateBackup(data);
  if (problem) { await dialog({ title: 'Can’t restore this file', message: problem, buttons: [{ label: 'OK', value: true, kind: 'primary' }] }); return; }
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'an unknown date';
  const r = await dialog({
    title: 'Restore backup?',
    message: `This backup from ${when} has ${data.entries.length} log entries and ${data.saved.length} saved meals.`,
    buttons: [
      { label: 'Add to what’s on this phone', value: 'merge', kind: 'primary' },
      { label: 'Replace everything', value: 'replace', kind: 'danger' },
      { label: 'Cancel', value: null },
    ],
  });
  if (!r.value) return;
  if (r.value === 'replace' && !(await confirmDialog('Replace everything?', 'Everything currently on this phone will be swapped for the backup. This can’t be undone.', 'Replace'))) return;
  busy('Restoring…');
  try {
    const n = await importAll(data, r.value);
    unbusy();
    toast(`Restored ${n.entries} entries and ${n.saved} saved meals.`);
    render();
  } catch (e) {
    unbusy();
    toast('Restore failed: ' + (e.message || e));
  }
});

// ── Actions ────────────────────────────────────────────────────
const ACT = {
  tab: el => {
    if (el.dataset.tab === 'today') { S.viewDate = dateKey(); S.followToday = true; }
    go(el.dataset.tab);
  },
  'go-add': () => go('add'),
  'go-text': () => go('text'),
  'go-scan': () => { S.scanError = ''; warmUp(); go('scan'); },
  'back-add': () => go('add'),
  'back-scan': () => { S.scanError = ''; go('scan'); },
  'back-notfound': () => go('notfound'),
  'back-saved': () => go('saved'),
  'cancel-photo': () => { S.photo = null; S.photoNote = ''; go('add'); },
  'cancel-text': () => go('add'),
  'cancel-review': async () => {
    const d = S.draft;
    if (d && d.mode === 'new' && d.aiInput && !(await confirmDialog('Discard this estimate?', 'It hasn’t been added to your log.', 'Discard'))) return;
    const back = d?.mode === 'saved' ? 'savedDetail' : d?.mode === 'edit' ? 'today' : 'add';
    S.draft = null;
    go(back);
  },

  'day-prev': () => { S.viewDate = addDays(S.viewDate, -1); S.followToday = false; render(); },
  'day-next': () => {
    const next = addDays(S.viewDate, 1);
    if (next > dateKey()) return;
    S.viewDate = next; S.followToday = next === dateKey(); render();
  },
  'day-today': () => { S.viewDate = dateKey(); S.followToday = true; render(); },
  'dismiss-install': () => { setFlag('installDismissed', true); render(); },
  'show-install': () => { setFlag('installDismissed', false); S.viewDate = dateKey(); S.followToday = true; go('today'); },
  'open-entry': async el => {
    const e = await db.get('entries', el.dataset.id);
    if (!e) return;
    S.draft = draftFromEntry(e);
    go('review');
  },

  'take-photo': () => inputs.camera.click(),
  'choose-photo': () => inputs.library.click(),
  'estimate-photo': () => {
    const p = S.photo;
    if (!p) return;
    runMealEstimate({ imageBase64: p.base64, note: S.photoNote.trim(), thumb: p.thumb }, CONFIG.MODELS.fast);
  },
  'estimate-text': () => {
    const t = S.textInput.trim();
    if (t.length < 2) { toast('Type what you ate first.'); return; }
    runMealEstimate({ text: t }, CONFIG.MODELS.fast);
  },
  recheck: () => {
    const d = S.draft;
    if (!d || !d.aiInput) return;
    if (d.aiInput.kind === 'label') return runLabelRead(CONFIG.MODELS.accurate);
    runMealEstimate(d.aiInput, CONFIG.MODELS.accurate);
  },

  'qty-minus': el => changeQty(Number(el.dataset.i), -1),
  'qty-plus': el => changeQty(Number(el.dataset.i), 1),
  'grams-chip': el => {
    const i = Number(el.dataset.i);
    const it = S.draft.items[i];
    it.qty = Number(el.dataset.g) / (it.grams || 100);
    refreshItem(i);
  },
  'edit-nums': el => {
    const i = Number(el.dataset.i);
    S.draft.items[i]._edit = true;
    const card = $view.querySelector(`.item[data-i="${i}"]`);
    card.querySelector('[data-sum]').hidden = true;
    card.querySelector('[data-nums]').hidden = false;
    const first = card.querySelector('[data-nums] input');
    if (first) first.focus();
  },
  'remove-item': el => {
    S.draft.items.splice(Number(el.dataset.i), 1);
    render();
  },
  'add-item': () => {
    S.draft.items.push(makeItem({ name: '', qty: 1 }));
    render().then(() => {
      const inputsList = $view.querySelectorAll('.item-name');
      const last = inputsList[inputsList.length - 1];
      if (last) { last.focus(); last.scrollIntoView({ block: 'center' }); }
    });
  },
  'set-meal': el => {
    S.draft.meal = el.dataset.meal;
    $view.querySelectorAll('[data-act="set-meal"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.meal === S.draft.meal)));
  },
  'save-draft': () => saveDraft().catch(e => toast('Couldn’t save: ' + (e.message || e))),
  'delete-entry': async () => {
    const d = S.draft;
    if (!(await confirmDialog('Delete this entry?', 'It will be removed from your log.', 'Delete'))) return;
    const old = await db.get('entries', d.entryId);
    await db.del('entries', d.entryId);
    S.draft = null;
    go('today');
    if (old) toast('Entry deleted.', { label: 'Undo', run: async () => { await db.put('entries', old); render(); } });
  },

  'retry-camera': () => { S.scanError = ''; render(); },
  'scan-photo': () => { if (S.scanner) { S.scanner.stop(); S.scanner = null; } inputs.barcode.click(); },
  'lookup-typed': () => {
    const code = cleanBarcode(S.typedCode);
    if (code.length < 8) { toast('Type all the digits under the barcode (usually 13).'); return; }
    handleBarcode(code);
  },
  'retry-lookup': () => handleBarcode(S.notFound.code),
  'label-photo': () => { S.labelFor = S.notFound?.code || null; S.labelNote = ''; inputs.label.click(); },
  'read-label': () => runLabelRead(CONFIG.MODELS.fast),
  'manual-product': () => {
    const nf = S.notFound;
    const base = nf?.product;
    openProduct({
      barcode: nf.code,
      name: base?.name && base.name !== 'Unnamed product' ? base.name : '',
      brand: base?.brand || '',
      per100: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      servingG: base?.servingG || 0,
      unit: base?.unit || 'g',
    }, 'manual');
    S.draft.productInfo = 'Type the “per 100 g” values from the nutrition panel, then the amount you ate.';
    S.draft.items[0].qty = 1;
    render();
  },

  'open-saved': el => { S.savedId = el.dataset.id; S.savedFactor = 1; S.savedMeal = mealForTime(); go('savedDetail'); },
  'quick-log': async el => {
    const entry = await logSaved(el.dataset.id, 1, mealForTime());
    if (!entry) return;
    toast(`Added ${entry.title} to ${MEAL_SINGULAR[entry.meal]}.`, { label: 'Undo', run: async () => { await db.del('entries', entry.id); render(); } });
    render();
  },
  'saved-factor': el => { S.savedFactor = Number(el.dataset.f); render(); },
  'saved-meal': el => { S.savedMeal = el.dataset.meal; $view.querySelectorAll('[data-act="saved-meal"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.meal === S.savedMeal))); },
  'saved-log': async el => {
    const entry = await logSaved(el.dataset.id, S.savedFactor, S.savedMeal);
    if (!entry) return;
    S.viewDate = dateKey(); S.followToday = true;
    go('today');
    toast(`Added ${entry.title} to ${MEAL_SINGULAR[entry.meal]}.`, { label: 'Undo', run: async () => { await db.del('entries', entry.id); render(); } });
  },
  'saved-edit': async el => {
    const s = await db.get('saved', el.dataset.id);
    if (!s) return;
    S.draft = newDraft({ mode: 'saved', savedId: s.id, name: s.name, items: s.items.map(makeItem), thumb: s.thumb || null, source: s.source });
    go('review');
  },
  'saved-rename': async el => {
    const s = await db.get('saved', el.dataset.id);
    if (!s) return;
    const r = await dialog({ title: 'Rename saved meal', input: { value: s.name }, buttons: [{ label: 'Save', value: true, kind: 'primary' }, { label: 'Cancel', value: false }] });
    if (!r.value || !r.text.trim()) return;
    await db.put('saved', { ...s, name: r.text.trim().slice(0, 60) });
    render();
  },
  'saved-delete': async el => {
    const s = await db.get('saved', el.dataset.id);
    if (!s) return;
    if (!(await confirmDialog(`Delete “${s.name}”?`, 'It will be removed from Saved meals. Entries already in your log stay.', 'Delete'))) return;
    await db.del('saved', s.id);
    S.draft = null;
    go('saved');
    toast('Saved meal deleted.', { label: 'Undo', run: async () => { await db.put('saved', s); render(); } });
  },

  range: el => { S.historyDays = Number(el.dataset.n); render(); },
  'open-day': el => { S.viewDate = el.dataset.date; S.followToday = el.dataset.date === dateKey(); go('today'); },

  'save-key': () => {
    const v = document.getElementById('api-key').value.trim();
    if (!v) { toast('Paste your key into the box first.'); return; }
    if (!v.startsWith('sk-ant-')) toast('Saved, but Anthropic keys usually start with “sk-ant-”. Check it was copied fully.', null, 6000);
    else toast('Key saved on this phone.');
    setApiKey(v);
    render();
  },
  'show-key': el => {
    const inp = document.getElementById('api-key');
    const showing = inp.type === 'text';
    if (!inp.value && getApiKey()) inp.value = getApiKey();
    inp.type = showing ? 'password' : 'text';
    el.textContent = showing ? 'Show' : 'Hide';
  },
  'test-key': async () => {
    busy('Testing your key…');
    try {
      await testKey(getApiKey());
      unbusy();
      toast('Your key works.');
      render();
    } catch (e) {
      unbusy();
      await dialog({ title: 'Key test failed', message: e.message, buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
    }
  },
  'remove-key': async () => {
    if (!(await confirmDialog('Remove the API key?', 'Photo and typed estimates will stop working on this phone until you add a key again.', 'Remove'))) return;
    setApiKey('');
    render();
  },
  'macro-mode': el => {
    const mode = el.dataset.mode;
    const g = macroGoals();
    const patch = { macroMode: mode };
    if (mode === 'custom') {
      const st = getSettings();
      if (!st.proteinGoal) patch.proteinGoal = g.protein;
      if (!st.carbsGoal) patch.carbsGoal = g.carbs;
      if (!st.fatGoal) patch.fatGoal = g.fat;
    }
    saveSettings(patch);
    render();
  },
  'reset-usage': async () => {
    if (!(await confirmDialog('Reset the AI use counter?', 'This only clears the count on this phone. It doesn’t change your Anthropic bill.', 'Reset', 'primary'))) return;
    resetUsage();
    render();
  },
  export: async () => {
    const data = (await S.exportReady) || (await exportAll());
    const name = `thali-backup-${dateKey()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    let done = false;
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Thali backup' });
        done = true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // closed the share sheet
    }
    if (!done) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      done = true;
    }
    saveSettings({ lastBackup: new Date().toISOString() });
    toast('Backup ready. Choose “Save to Files” so you can find it later.', null, 6000);
    render();
  },
  import: () => inputs.import.click(),
  'check-update': async () => {
    if (!('serviceWorker' in navigator)) { toast('Updates aren’t available in this browser.'); return; }
    busy('Checking for updates…');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
      unbusy();
      if (reg && (reg.waiting || reg.installing)) offerUpdate(reg);
      else toast('You have the latest version.');
    } catch {
      unbusy();
      toast('Couldn’t check for updates. Are you online?');
    }
  },
  'erase-all': async () => {
    if (!(await confirmDialog('Erase everything?', 'This deletes your whole log, saved meals, remembered barcodes, goals and API key from this phone. Save a backup first if you might want it.', 'Erase everything'))) return;
    if (!(await confirmDialog('Are you sure?', 'This can’t be undone.', 'Yes, erase'))) return;
    await eraseEverything();
    S.draft = null;
    go('today');
    toast('Everything was erased.');
  },
};

function changeQty(i, dir) {
  const it = S.draft.items[i];
  it.qty = stepQty(it.qty, dir);
  refreshItem(i);
}

$view.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
$tabs.addEventListener('click', e => {
  const el = e.target.closest('[data-tab]');
  if (el) ACT.tab(el);
});

// Typing into fields.
$view.addEventListener('input', e => {
  const el = e.target;
  const bind = el.dataset.bind;
  if (bind) return onBind(el, bind, 'input');
});
$view.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.bind) return onBind(el, el.dataset.bind, 'change');
  if (el.dataset.setting) {
    const v = Math.round(nonNeg(el.value));
    if (el.dataset.setting === 'calorieGoal' && v < 500) { toast('That goal looks too low. Enter calories (kcal) per day.'); el.value = getSettings().calorieGoal; return; }
    saveSettings({ [el.dataset.setting]: v });
    toast('Goal saved.');
    render();
  }
});
$view.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'typed-code') { e.preventDefault(); ACT['lookup-typed'](); }
});

function onBind(el, bind, kind) {
  // Fields that aren't part of a draft.
  if (bind === 'photoNote') { S.photoNote = el.value; return; }
  if (bind === 'textInput') { S.textInput = el.value; return; }
  if (bind === 'labelNote') { S.labelNote = el.value; return; }
  if (bind === 'typedCode') { S.typedCode = el.value; return; }
  const d = S.draft;
  if (!d) return;
  if (bind === 'favourite') {
    d.favourite = el.checked;
    const box = $view.querySelector('.fav-name');
    if (box) box.hidden = !el.checked;
    return;
  }
  if (bind === 'rememberProduct') { d.rememberProduct = el.checked; return; }
  if (bind === 'favName') { d.favName = el.value; return; }
  if (bind === 'name' && el.dataset.i === undefined) { d.name = el.value; return; }
  if (bind === 'date') { if (el.value) d.date = el.value > dateKey() ? dateKey() : el.value; return; }

  const i = Number(el.dataset.i);
  const it = d.items[i];
  if (!it) return;
  if (bind === 'name') { it.name = el.value; return; }
  if (bind === 'portion') { it.portion = el.value; return; }

  const raw = el.value.trim();
  if (kind === 'input' && (raw === '' || /[.,]$/.test(raw))) return; // wait until they finish typing
  const v = nonNeg(raw);

  if (bind === 'eaten') {
    if (it.grams > 0) it.qty = v / it.grams;
    else if (it.qty > 0) it.grams = v / it.qty;
    if (it.per100 && it.grams === 0) { it.grams = 100; it.qty = v / 100; }
    refreshItem(i, el);
  } else if (['kcal', 'protein', 'carbs', 'fat'].includes(bind)) {
    if (it.per100) it[bind] = v;            // per-100 value typed directly
    else it[bind] = it.qty > 0 ? v / it.qty : v; // eaten value → per-portion base
    refreshItem(i, el);
  }
  if (kind === 'change') refreshItem(i);
}

// ── Service worker and updates ─────────────────────────────────
function offerUpdate(reg) {
  toast('A new version of Thali is ready.', {
    label: 'Update now',
    run: () => {
      const w = reg.waiting;
      if (w) w.postMessage('skipWaiting');
      else window.location.reload();
    },
  }, 15000);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(reg);
      });
    });
  }).catch(() => { /* offline support unavailable */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// Ask the browser to keep our data even when the phone is low on space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

window.addEventListener('online', () => { if (S.screen === 'add') render(); });
window.addEventListener('offline', () => { if (S.screen === 'add') render(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.screen === 'today' && S.followToday && S.viewDate !== dateKey()) render();
  if (document.visibilityState === 'hidden' && S.scanner) { S.scanner.stop(); S.scanner = null; }
  if (document.visibilityState === 'visible' && S.screen === 'scan' && !S.scanner) render();
});

// For testing in a desktop browser.
window.__thali = { S, go, render };

render();
