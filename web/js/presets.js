// Filter presets: one-click looks for the manga renderer, plus a strength slider.
//
// A preset is applied by writing into the existing controls (by id) and dispatching
// `input` / `change` / `click` events, so the normal wiring in main.js does the rendering.
//
// Blending: picking a preset snapshots the current control values as BASE. Strength s (0..1)
// then moves numeric controls from BASE toward the preset; selects, checkboxes and the style
// switch to the preset value once s >= 0.5. Choosing "none" (the "Original" entry)
// restores BASE exactly. A trusted (user) change to a driven control makes the current
// values the new BASE and sets strength to 100, keeping the preset name selected.

const STORE_KEY = 'mangaPresets.v1';

// Numeric range controls: blended linearly, snapped to the input's step, clamped to min/max.
const NUMERIC = ['lineWidth', 'outlineWidth', 'sunAz', 'sunEl', 'shade', 'haze',
  'toneShadow', 'toneBase', 'toneSize', 'toneOpacity', 'blackRange'];
// Checkboxes and selects: discrete, switch at strength >= 0.5.
const CHECKS = ['skyTone', 'toneGray', 'whiteLines'];
const SELECTS = ['tonePattern', 'season', 'treeStyle', 'leafEdge'];

// Values are in the units of the input they drive (percent, degrees, mm, multiplier, ...).
export const PRESETS = [
  { id: 'none', name: 'Original', style: null, values: {} },
  {
    id: 'classic', name: 'Classic manga', style: 'lines-tone',
    values: {
      lineWidth: 1.2, outlineWidth: 1.5, sunAz: 60, sunEl: 32, shade: 130, haze: 80, skyTone: true,
      toneShadow: 100, toneBase: 100, tonePattern: 'dots', toneSize: 0.4, toneOpacity: 90, toneGray: false,
      blackRange: 40, whiteLines: true, season: 'summer', treeStyle: 'tone', leafEdge: 'bumpy',
    },
  },
  {
    // Korean webtoon background: bright pastel colour, thin brown lines, flat cel light bands,
    // a dreamy glow and a soft haze in the distance. Uses the effect stack (applied by main.js).
    id: 'manhwa', name: 'Manhwa', style: 'color-lines',
    values: {
      lineWidth: 0.6, outlineWidth: 1.0, sunAz: 135, sunEl: 52, shade: 55, haze: 110, skyTone: true,
      season: 'summer', leafEdge: 'fluffy',
    },
    effects: [
      { id: 'fog', strength: 1, params: { density: 0.22, color: '#eef2f8' } },
      { id: 'cel', strength: 1, params: { bands: 3, softness: 0.35, lift: 0.42 } },
      { id: 'grade', strength: 1, params: { brightness: -0.12, contrast: 1.0, saturation: 1.3, temperature: 0.08, tint: 0.02 } },
      { id: 'linecolor', strength: 1, params: { color: '#3a2a2e', threshold: 0.22 } },
      { id: 'glow', strength: 1, params: { radius: 10, amount: 0.18 } },
    ],
  },
  {
    id: 'soft', name: 'Soft shoujo', style: 'lines-tone',
    values: {
      lineWidth: 0.6, outlineWidth: 1.0, sunAz: 60, sunEl: 40, shade: 90, haze: 120, skyTone: true,
      toneShadow: 80, toneBase: 70, tonePattern: 'stipple', toneSize: 0.6, toneOpacity: 50, toneGray: true,
      blackRange: 15, whiteLines: true, season: 'spring', treeStyle: 'tone-noline', leafEdge: 'fluffy',
    },
    effects: [
      { id: 'glow', strength: 1, params: { radius: 8, amount: 0.22 } },
    ],
  },
  {
    id: 'noir', name: 'Noir', style: 'lines-tone',
    values: {
      lineWidth: 1.4, outlineWidth: 1.8, sunAz: 60, sunEl: 24, shade: 140, haze: 60, skyTone: false,
      toneShadow: 200, toneBase: 100, tonePattern: 'hatchgrad', toneSize: 0.5, toneOpacity: 100, toneGray: false,
      blackRange: 75, whiteLines: true, season: 'autumn', treeStyle: 'tone', leafEdge: 'smooth',
    },
  },
  {
    id: 'sketch', name: 'Sketch', style: 'lineart',
    values: {
      lineWidth: 0.5, outlineWidth: 1.0, sunAz: 135, sunEl: 45, shade: 100, haze: 60, skyTone: false,
      toneShadow: 0, toneBase: 100, tonePattern: 'dots', toneSize: 0.4, toneOpacity: 0, toneGray: false,
      blackRange: 30, whiteLines: true, season: 'winter', treeStyle: 'lines', leafEdge: 'smooth',
    },
  },
  {
    id: 'action', name: 'Action', style: 'lines-tone',
    values: {
      lineWidth: 1.7, outlineWidth: 2.2, sunAz: 90, sunEl: 35, shade: 120, haze: 40, skyTone: false,
      toneShadow: 130, toneBase: 120, tonePattern: 'speed', toneSize: 0.8, toneOpacity: 100, toneGray: false,
      blackRange: 55, whiteLines: true, season: 'summer', treeStyle: 'lines', leafEdge: 'bumpy',
    },
  },
  {
    id: 'dusk', name: 'Dusk', style: 'color-lines',
    values: {
      lineWidth: 0.9, outlineWidth: 1.2, sunAz: 260, sunEl: 10, shade: 90, haze: 140, skyTone: true,
      toneShadow: 100, toneBase: 100, tonePattern: 'gradient', toneSize: 0.6, toneOpacity: 60, toneGray: false,
      blackRange: 35, whiteLines: false, season: 'summer', treeStyle: 'tone-noline', leafEdge: 'bumpy',
    },
    effects: [
      { id: 'fog', strength: 1, params: { density: 0.26, color: '#f0b98a' } },
      { id: 'grade', strength: 1, params: { brightness: -0.04, contrast: 1.08, saturation: 1.15, temperature: 0.3, tint: 0.05 } },
      { id: 'glow', strength: 1, params: { radius: 12, amount: 0.2 } },
    ],
  },
  {
    id: 'study', name: 'Study', style: 'clay',
    values: {
      lineWidth: 0.8, outlineWidth: 1.0, sunAz: 120, sunEl: 48, shade: 140, haze: 90, skyTone: false,
      toneShadow: 80, toneBase: 100, tonePattern: 'stipple', toneSize: 0.3, toneOpacity: 40, toneGray: false,
      blackRange: 20, whiteLines: false, season: 'summer', treeStyle: 'tone-noline', leafEdge: 'smooth',
    },
    effects: [
      { id: 'grade', strength: 1, params: { brightness: 0.07, contrast: 0.95, saturation: 0.9, temperature: 0, tint: 0 } },
    ],
  },
  {
    id: 'print', name: 'Print', style: 'lines-tone',
    values: {
      lineWidth: 1.6, outlineWidth: 2.6, sunAz: 60, sunEl: 36, shade: 125, haze: 90, skyTone: false,
      toneShadow: 120, toneBase: 90, tonePattern: 'crosshatch', toneSize: 0.6, toneOpacity: 100, toneGray: false,
      blackRange: 60, whiteLines: true, season: 'autumn', treeStyle: 'lines', leafEdge: 'bumpy',
    },
  },
];

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const decimalsOf = (step) => { const s = String(step); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
// Next animation frame, with a timeout fallback: rAF never fires in hidden/background tabs.
const frame = (fn) => {
  let done = false;
  const run = () => { if (!done) { done = true; clearTimeout(t); if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(r); fn(); } };
  const t = setTimeout(run, 50);
  const r = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(run) : 0;
  return { cancel() { done = true; clearTimeout(t); if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(r); } };
};
const unframe = (h) => h && h.cancel();
const resolveEl = (x) => (typeof x === 'string' ? document.getElementById(x) : x || null);

function getStore() {
  try { return globalThis.localStorage || null; } catch { return null; }
}
function loadSaved() {
  try {
    const v = JSON.parse(getStore()?.getItem(STORE_KEY) ?? 'null');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function saveSaved(data) {
  try { getStore()?.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* storage blocked or full */ }
}

function styleButtons() {
  return Array.from(document.querySelectorAll('#styleSeg [data-style]'));
}
function activeStyle() {
  const b = styleButtons().find((x) => x.classList.contains('on'));
  return b ? b.dataset.style : null;
}

// Blend one numeric control from base toward target at strength s (0..1).
function blendNumber(c, base, target, s) {
  if (s <= 0) return base;
  const lo = num(c.min, 0);
  const hi = num(c.max, 100);
  const step = num(c.step, 1) || 1;
  const v = base + (target - base) * s;
  const snapped = lo + Math.round((v - lo) / step) * step;
  return Number(clamp(snapped, lo, hi).toFixed(decimalsOf(step)));
}

/**
 * Fill the preset <select> `picker` and wire the strength slider.
 * Accepts elements or element ids for picker / strength / strengthOut.
 * Returns { select(id), current() }.
 */
export function initPresets({ picker, strength, strengthOut, onChange } = {}) {
  const pickerEl = resolveEl(picker);
  const strengthEl = resolveEl(strength);
  const outEl = resolveEl(strengthOut);

  let selected = 'none';
  let BASE = null;          // snapshot of driven controls taken when leaving 'none'
  let pending = null;       // pending requestAnimationFrame handle for strength drags
  let strengthValue = clamp(num(strengthEl?.value, 100), 0, 100) / 100;

  const presetById = (id) => PRESETS.find((p) => p.id === id);

  function readDom() {
    const snap = {};
    for (const id of NUMERIC) { const c = $(id); if (c) snap[id] = num(c.value, 0); }
    for (const id of CHECKS) { const c = $(id); if (c) snap[id] = !!c.checked; }
    for (const id of SELECTS) { const c = $(id); if (c) snap[id] = c.value; }
    snap.style = activeStyle();
    return snap;
  }

  // Write the blend of BASE and preset at strength s. Only changed values are written and dispatched.
  function applyBlend(preset, s) {
    if (!BASE) return;
    const vals = preset.values;

    for (const id of NUMERIC) {
      const c = $(id);
      const base = BASE[id];
      if (!c || base == null) continue;
      const v = String(blendNumber(c, base, vals[id] ?? base, s));
      if (c.value !== v) {
        c.value = v;
        c.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    for (const id of CHECKS) {
      const c = $(id);
      const base = BASE[id];
      if (!c || base == null) continue;
      const v = s >= 0.5 ? (vals[id] ?? base) : base;
      if (c.checked !== v) {
        c.checked = v;
        c.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    for (const id of SELECTS) {
      const c = $(id);
      const base = BASE[id];
      if (!c || base == null) continue;
      const v = s >= 0.5 ? (vals[id] ?? base) : base;
      if (c.value !== v) {
        c.value = v;
        c.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const wantStyle = s >= 0.5 ? (preset.style ?? BASE.style) : BASE.style;
    if (wantStyle) {
      const b = styleButtons().find((x) => x.dataset.style === wantStyle);
      if (b && !b.classList.contains('on')) b.click();
    }
  }

  function cancelPending() {
    if (pending !== null) { unframe(pending); pending = null; }
  }
  // Throttle drags: at most one blend per animation frame, using the latest strength.
  function scheduleBlend() {
    if (pending !== null) return;
    pending = frame(() => {
      pending = null;
      applyBlend(presetById(selected), strengthValue);
    });
  }

  function markPicker() {
    if (pickerEl && pickerEl.value !== selected) pickerEl.value = selected;
  }
  function showStrength() {
    if (outEl) outEl.textContent = `${Math.round(strengthValue * 100)}%`;
  }
  function finish() {
    markPicker();
    showStrength();
    saveSaved({ id: selected, pct: Math.round(strengthValue * 100) });
    onChange?.(selected, strengthValue);
  }

  function select(id) {
    const p = presetById(id);
    if (!p) return;
    cancelPending();
    if (p.id === 'none') {
      // Restore the original settings exactly, if a preset was active.
      if (selected !== 'none' && BASE) applyBlend(p, 0);
      selected = 'none';
    } else {
      // Keep the BASE captured when the first preset was picked, so switching presets does not
      // bake a blended look into the base.
      if (selected === 'none' || !BASE) BASE = readDom();
      selected = p.id;
      // Picking a look should always show it: a strength left at 0 % jumps to 100 %.
      if (strengthValue === 0) {
        strengthValue = 1;
        if (strengthEl) strengthEl.value = '100';
      }
      applyBlend(p, strengthValue);
    }
    finish();
  }

  // A user (trusted) edit to a driven control: current values become BASE, strength 100.
  // The DOM is left as it is; the preset name stays selected.
  function onUserEdit(e, styleOverride) {
    if (!e.isTrusted || selected === 'none') return;
    cancelPending();
    BASE = readDom();
    if (styleOverride !== undefined) BASE.style = styleOverride;
    strengthValue = 1;
    if (strengthEl) strengthEl.value = '100';
    finish();
  }

  // Dropdown: "Original" restores the base look; any other entry applies that preset.
  if (pickerEl) {
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.setAttribute('data-i18n', `preset.${p.id}`);
      o.textContent = p.name;
      pickerEl.appendChild(o);
    }
    pickerEl.addEventListener('change', () => select(pickerEl.value));
  }

  // Strength slider
  if (strengthEl) {
    strengthEl.addEventListener('input', () => {
      strengthValue = clamp(num(strengthEl.value, 100), 0, 100) / 100;
      if (selected !== 'none') scheduleBlend();
      finish();
    });
  }

  // User edits to driven controls rebase the preset.
  for (const id of NUMERIC) $(id)?.addEventListener('input', (e) => onUserEdit(e));
  for (const id of [...CHECKS, ...SELECTS]) $(id)?.addEventListener('change', (e) => onUserEdit(e));
  for (const b of styleButtons()) {
    b.addEventListener('click', (e) => onUserEdit(e, b.dataset.style));
  }

  // Start at "Original" every load: re-applying the last preset would override the look a shared
  // link (URL hash) asks for. Only the strength slider position is remembered.
  const saved = loadSaved();
  if (strengthEl && saved && Number.isFinite(Number(saved.pct)) && Number(saved.pct) > 0) {
    strengthEl.value = String(clamp(Math.round(Number(saved.pct)), 0, 100));
    strengthValue = clamp(num(strengthEl.value, 100), 0, 100) / 100;
  }
  markPicker();
  showStrength();
  finish();

  return { select, current: () => selected };
}
