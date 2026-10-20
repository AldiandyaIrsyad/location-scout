// Effects panel: the toolbar button, the floating card and the ordered effect list.
// List format (shared with the renderer): [{ id, enabled, strength (0-1), params }], in application order.
// Post effects keep their user order; world effects are kept after them and are not reorderable.
import { EFFECTS } from './effects.js';
import { t } from './i18n.js';

export const STORAGE_KEY = 'panelscape-effects.v1';

const DEF_BY_ID = new Map(EFFECTS.map((d) => [d.id, d]));
const HEX = /^#[0-9a-f]{6}$/i;
const ICON_CLOSE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_CHEVRON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9.5l6 6 6-6"/></svg>';
const ICON_UP = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 14.5l6-6 6 6"/></svg>';
const ICON_DOWN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9.5l6 6 6-6"/></svg>';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isWorld = (def) => def.kind === 'world';

function stepDecimals(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function rangeStep(pd) {
  if (pd.step) return pd.step;
  return Number.isInteger(pd.min) && Number.isInteger(pd.max) ? 1 : 0.01;
}

function optionValues(pd) {
  return (pd.options || []).map((o) => (typeof o === 'string' ? o : String(o.value)));
}

function paramDefault(pd) {
  if (pd.default !== undefined) return pd.default;
  if (pd.type === 'color') return '#000000';
  if (pd.type === 'select') return optionValues(pd)[0];
  return pd.min ?? 0;
}

/** Coerce a stored value to a valid value for one param (clamped, snapped to step, or a known option). */
function normParam(pd, v) {
  const d = paramDefault(pd);
  if (pd.type === 'color') return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d;
  if (pd.type === 'select') return optionValues(pd).includes(String(v)) ? String(v) : d;
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  const step = rangeStep(pd);
  const snapped = Math.round((n - pd.min) / step) * step + pd.min;
  return +clamp(snapped, pd.min, pd.max).toFixed(stepDecimals(step));
}

function makeEntry(def, src) {
  const s = src && typeof src === 'object' ? src : {};
  const sp = s.params && typeof s.params === 'object' ? s.params : {};
  const params = {};
  for (const pd of def.params || []) params[pd.id] = normParam(pd, sp[pd.id]);
  const st = Number(s.strength);
  const hasStrength = typeof s.strength === 'number' || (typeof s.strength === 'string' && s.strength.trim() !== '');
  return {
    id: def.id,
    kind: def.kind,
    enabled: Boolean(s.enabled),
    strength: hasStrength && Number.isFinite(st) ? clamp(st, 0, 1) : 1,
    params,
  };
}

/** Canonical list: saved/given entries first (post, then world), then any missing catalogue effects at defaults. */
function normalize(list) {
  const seen = new Set();
  const post = [];
  const world = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const def = item && typeof item === 'object' ? DEF_BY_ID.get(item.id) : undefined;
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      (isWorld(def) ? world : post).push(makeEntry(def, item));
    }
  }
  for (const def of EFFECTS) {
    if (seen.has(def.id)) continue;
    (isWorld(def) ? world : post).push(makeEntry(def, null));
  }
  return [...post, ...world];
}

function snapshot(entries) {
  return entries.map((e) => ({ id: e.id, enabled: e.enabled, strength: e.strength, params: { ...e.params } }));
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveList(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the list still works for this page view */
  }
}

/**
 * Wire the Effects button and panel.
 * @param {{button: HTMLElement, panel: HTMLElement, onChange?: (list: object[]) => void,
 *   toStorage?: (list: object[]) => object[]}} opts   toStorage maps the live list to what is persisted
 * @returns {{getList: () => object[], setList: (list: object[]) => void, open: () => void, close: () => void}}
 */
export function initEffectsUI({ button, panel, onChange, toStorage } = {}) {
  if (!button || !panel) throw new Error('initEffectsUI needs a button and a panel element');
  const doc = panel.ownerDocument;
  const countEl = button.querySelector('#effectsCount') || doc.getElementById('effectsCount');
  const titleId = `${panel.id || 'effectsPanel'}-title`;

  let entries = normalize(loadSaved());
  let isOpen = false;
  let dragId = null;
  let rafId = 0;
  let timerId = 0;
  let emitPending = false;
  const expanded = new Set();

  const el = (tag, cls, attrs) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const findEntry = (id) => entries.find((e) => e.id === id);
  const isPost = (e) => !isWorld(DEF_BY_ID.get(e.id));

  // ---------- Shell (built once; labels are set by applyText) ----------
  panel.classList.add('fx-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'fx-head');
  const title = el('h2', 'fx-title', { id: titleId });
  const actions = el('div', 'fx-head-actions');
  const clearBtn = el('button', 'btn small', { type: 'button', 'data-role': 'clear' });
  const resetBtn = el('button', 'btn small', { type: 'button', 'data-role': 'reset' });
  const closeBtn = el('button', 'btn icon-btn fx-close', { type: 'button', 'data-role': 'close' });
  closeBtn.innerHTML = ICON_CLOSE;
  actions.append(clearBtn, resetBtn, closeBtn);
  head.append(title, actions);

  const body = el('div', 'fx-body');
  const makeGroup = (kind) => {
    const wrap = el('div', 'fx-group', { 'data-group': kind });
    const h = el('h3', 'fx-group-title');
    const list = el('ul', 'fx-rows');
    wrap.append(h, list);
    return { wrap, title: h, list };
  };
  const groups = { post: makeGroup('post'), world: makeGroup('world') };
  body.append(groups.post.wrap, groups.world.wrap);
  panel.replaceChildren(head, body);

  // ---------- Text ----------
  function applyText() {
    button.title = t('tip.effects');
    title.textContent = t('fx.panel.title');
    clearBtn.textContent = t('fx.panel.clear');
    resetBtn.textContent = t('fx.panel.reset');
    closeBtn.setAttribute('aria-label', t('fx.panel.close'));
    closeBtn.title = t('fx.panel.close');
    groups.post.title.textContent = t('fx.panel.image');
    groups.world.title.textContent = t('fx.panel.world');
  }

  // ---------- Rows ----------
  function fmt(val, step) {
    return Number.isInteger(step) ? String(Math.round(val)) : Number(val).toFixed(stepDecimals(step));
  }

  function buildParam(entry, pd) {
    const wrap = el('label', 'fx-param');
    const label = el('span');
    label.textContent = t(`fx.param.${pd.id}`);
    wrap.append(label);
    const val = entry.params[pd.id];
    if (pd.type === 'color') {
      const inp = el('input', 'fx-color', { type: 'color', 'data-param': pd.id });
      inp.value = val;
      wrap.append(inp);
    } else if (pd.type === 'select') {
      const sel = el('select', null, { 'data-param': pd.id });
      for (const v of optionValues(pd)) {
        const o = el('option', null, { value: v });
        o.textContent = t(`fx.palette.${v}`);
        sel.append(o);
      }
      sel.value = String(val);
      wrap.append(sel);
    } else {
      const step = rangeStep(pd);
      const inp = el('input', null, {
        type: 'range',
        min: String(pd.min),
        max: String(pd.max),
        step: String(step),
        'data-param': pd.id,
      });
      inp.value = String(val);
      const out = el('output');
      out.textContent = fmt(val, step);
      wrap.append(inp, out);
    }
    return wrap;
  }

  function buildRow(entry, post) {
    const def = DEF_BY_ID.get(entry.id);
    const hasParams = (def.params || []).length > 0;
    const isExpanded = hasParams && expanded.has(def.id);
    const li = el('li', 'fx-row', { 'data-id': def.id });
    if (!post) li.classList.add('world');
    if (!entry.enabled) li.classList.add('off');
    if (isExpanded) li.classList.add('open');

    const line = el('div', 'fx-line');

    if (post) {
      const handle = el('span', 'fx-handle', { 'aria-hidden': 'true', title: t('fx.panel.drag') });
      handle.textContent = '⋮⋮';
      line.append(handle);
    } else {
      line.append(el('span', 'fx-handle ghost', { 'aria-hidden': 'true' }));
    }

    const enable = el('input', 'fx-enable', { type: 'checkbox', 'aria-label': t(`fx.${def.id}`) });
    enable.checked = entry.enabled;

    const nameWrap = el('div', 'fx-name-wrap');
    const name = el('span', 'fx-name');
    name.textContent = t(`fx.${def.id}`);
    nameWrap.append(name);
    if (def.needsDepth || !post) {
      const badge = el('span', def.needsDepth ? 'fx-badge depth' : 'fx-badge');
      badge.textContent = def.needsDepth ? t('fx.panel.depth') : t('fx.panel.worldBadge');
      nameWrap.append(badge);
    }
    line.append(enable, nameWrap);

    const sWrap = el('div', 'fx-strength');
    const range = el('input', null, {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      'aria-label': t('fx.panel.strength'),
      title: t('fx.panel.strength'),
      'data-strength': '',
    });
    range.value = String(Math.round(entry.strength * 100));
    const sOut = el('output');
    sOut.textContent = `${range.value}%`;
    sWrap.append(range, sOut);
    line.append(sWrap);

    if (post) {
      const idx = entries.filter(isPost).indexOf(entry);
      const count = entries.filter(isPost).length;
      const move = el('div', 'fx-move');
      const up = el('button', 'fx-mv', { type: 'button', 'data-act': 'up', 'aria-label': t('fx.panel.moveUp'), title: t('fx.panel.moveUp') });
      up.innerHTML = ICON_UP;
      up.disabled = idx <= 0;
      const down = el('button', 'fx-mv', { type: 'button', 'data-act': 'down', 'aria-label': t('fx.panel.moveDown'), title: t('fx.panel.moveDown') });
      down.innerHTML = ICON_DOWN;
      down.disabled = idx >= count - 1;
      move.append(up, down);
      line.append(move);
    }

    if (hasParams) {
      const exp = el('button', 'fx-expand', {
        type: 'button',
        'data-act': 'expand',
        'aria-label': t('fx.panel.settings'),
        'aria-expanded': String(isExpanded),
      });
      exp.innerHTML = ICON_CHEVRON;
      line.append(exp);
    } else {
      line.append(el('span', 'fx-expand-ghost', { 'aria-hidden': 'true' }));
    }

    li.append(line);

    if (hasParams) {
      const params = el('div', 'fx-params');
      params.hidden = !isExpanded;
      for (const pd of def.params) params.append(buildParam(entry, pd));
      li.append(params);
    }
    return li;
  }

  function renderRows() {
    const posts = entries.filter(isPost);
    groups.post.list.replaceChildren(...posts.map((e) => buildRow(e, true)));
    groups.world.list.replaceChildren(...entries.filter((e) => !isPost(e)).map((e) => buildRow(e, false)));
    updateCount();
  }

  function updateCount() {
    const n = entries.reduce((k, e) => k + (e.enabled ? 1 : 0), 0);
    if (countEl) {
      countEl.textContent = String(n);
      countEl.hidden = n === 0;
    }
    button.classList.toggle('on', n > 0);
  }

  // ---------- Change pipeline ----------
  function emit() {
    if (typeof onChange !== 'function') return;
    try {
      onChange(snapshot(entries));
    } catch (err) {
      console.error('[effects] onChange failed', err);
    }
  }

  // One emit per animation frame; the 60 ms timer covers hidden tabs where rAF does not fire.
  function scheduleEmit() {
    if (emitPending) return;
    emitPending = true;
    const fire = () => {
      if (!emitPending) return;
      emitPending = false;
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      rafId = 0;
      timerId = 0;
      emit();
    };
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(fire);
    timerId = setTimeout(fire, 60);
  }

  /** Call after any change: update the badge, persist, and notify (throttled). */
  function changed() {
    updateCount();
    saveList(toStorage ? toStorage(snapshot(entries)) : snapshot(entries));
    scheduleEmit();
  }

  // ---------- Edits ----------
  function moveBy(id, dir) {
    const posts = entries.filter(isPost);
    const i = posts.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= posts.length) return false;
    const a = entries.indexOf(posts[i]);
    const b = entries.indexOf(posts[j]);
    [entries[a], entries[b]] = [entries[b], entries[a]];
    return true;
  }

  /** Move fromId before or after toId; both must be post effects. */
  function reorder(fromId, toId, after) {
    const from = entries.findIndex((e) => e.id === fromId);
    const to0 = entries.findIndex((e) => e.id === toId);
    if (from < 0 || to0 < 0 || from === to0 || !isPost(entries[from]) || !isPost(entries[to0])) return false;
    const [item] = entries.splice(from, 1);
    const to = entries.findIndex((e) => e.id === toId);
    entries.splice(after ? to + 1 : to, 0, item);
    return true;
  }

  function clearAll() {
    entries = entries.map((e) => ({ ...e, enabled: false }));
    renderRows();
    changed();
  }

  function resetAll() {
    entries = normalize(null);
    renderRows();
    changed();
  }

  function focusMove(id, dir) {
    const row = groups.post.list.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    const first = row.querySelector(dir < 0 ? '[data-act="up"]' : '[data-act="down"]');
    const second = row.querySelector(dir < 0 ? '[data-act="down"]' : '[data-act="up"]');
    const target = first && !first.disabled ? first : second;
    if (target && !target.disabled) target.focus();
  }

  // Input, select and checkbox changes update one entry in place (no rebuild, so focus and drags survive).
  function applyControl(target) {
    const row = target.closest('.fx-row');
    if (!row) return;
    const entry = findEntry(row.dataset.id);
    const def = entry && DEF_BY_ID.get(entry.id);
    if (!entry || !def) return;

    if (target.type === 'checkbox') {
      entry.enabled = target.checked;
      row.classList.toggle('off', !entry.enabled);
    } else if (target.hasAttribute('data-strength')) {
      entry.strength = clamp(Number(target.value) / 100, 0, 1);
      const out = target.nextElementSibling;
      if (out) out.textContent = `${Math.round(entry.strength * 100)}%`;
    } else if (target.hasAttribute('data-param')) {
      const pd = (def.params || []).find((p) => p.id === target.getAttribute('data-param'));
      if (!pd) return;
      entry.params[pd.id] = normParam(pd, target.value);
      if (target.type === 'range') {
        const out = target.nextElementSibling;
        if (out) out.textContent = fmt(entry.params[pd.id], rangeStep(pd));
      }
    } else {
      return;
    }
    changed();
  }

  function clearDropMarks() {
    body.querySelectorAll('.fx-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  }

  // ---------- Events ----------
  clearBtn.addEventListener('click', clearAll);
  resetBtn.addEventListener('click', resetAll);
  closeBtn.addEventListener('click', () => closePanel(true));

  body.addEventListener('input', (ev) => {
    const tgt = ev.target;
    if (tgt.type === 'range' || tgt.type === 'color') applyControl(tgt);
  });
  body.addEventListener('change', (ev) => {
    const tgt = ev.target;
    if (tgt.type === 'checkbox' || tgt.tagName === 'SELECT') applyControl(tgt);
  });

  body.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.fx-row');
    if (!row) return;
    const id = row.dataset.id;
    const act = btn.getAttribute('data-act');
    if (act === 'up' || act === 'down') {
      const dir = act === 'up' ? -1 : 1;
      if (!moveBy(id, dir)) return;
      renderRows();
      changed();
      focusMove(id, dir);
    } else if (act === 'expand') {
      const open = !expanded.has(id);
      if (open) expanded.add(id);
      else expanded.delete(id);
      row.classList.toggle('open', open);
      const params = row.querySelector('.fx-params');
      if (params) params.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
  });

  // Reorder: the handle arms dragging on its row (so sliders inside rows keep working), then HTML5 DnD.
  body.addEventListener('pointerdown', (ev) => {
    const handle = ev.target.closest && ev.target.closest('.fx-handle');
    const row = handle && handle.closest('.fx-row');
    if (row && !row.classList.contains('world')) row.draggable = true;
  });
  body.addEventListener('pointerup', (ev) => {
    const row = ev.target.closest && ev.target.closest('.fx-row');
    if (row && !dragId) row.draggable = false;
  });
  body.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest && ev.target.closest('.fx-row');
    if (!row || row.classList.contains('world') || !row.draggable) {
      ev.preventDefault();
      return;
    }
    dragId = row.dataset.id;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', dragId);
    }
    row.classList.add('dragging');
  });
  body.addEventListener('dragover', (ev) => {
    const row = ev.target.closest && ev.target.closest('.fx-row');
    if (!dragId || !row || row.classList.contains('world') || row.dataset.id === dragId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const r = row.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    clearDropMarks();
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  body.addEventListener('dragleave', (ev) => {
    const row = ev.target.closest && ev.target.closest('.fx-row');
    if (row && !row.contains(ev.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
  });
  body.addEventListener('drop', (ev) => {
    const row = ev.target.closest && ev.target.closest('.fx-row');
    if (!dragId || !row || row.classList.contains('world')) return;
    ev.preventDefault();
    const after = row.classList.contains('drop-after');
    const from = dragId;
    const to = row.dataset.id;
    dragId = null;
    clearDropMarks();
    if (reorder(from, to, after)) {
      renderRows();
      changed();
    }
  });
  body.addEventListener('dragend', () => {
    dragId = null;
    clearDropMarks();
    body.querySelectorAll('.fx-row').forEach((r) => {
      r.draggable = false;
      r.classList.remove('dragging');
    });
  });

  // ---------- Open / close ----------
  function open() {
    isOpen = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function closePanel(focusButton) {
    isOpen = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  }

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', panel.id || 'effectsPanel');
  button.addEventListener('click', () => (isOpen ? closePanel(false) : open()));
  doc.addEventListener('pointerdown', (ev) => {
    if (!isOpen) return;
    const n = ev.target;
    if (panel.contains(n) || button.contains(n)) return;
    closePanel(false);
  });
  doc.addEventListener('keydown', (ev) => {
    if (isOpen && ev.key === 'Escape') closePanel(true);
  });

  // ---------- Init ----------
  applyText();
  renderRows();
  panel.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  if (typeof window !== 'undefined') {
    window.addEventListener('langchange', () => {
      applyText();
      renderRows();
    });
  }
  emit();

  return {
    getList: () => snapshot(entries),
    setList(list) {
      entries = normalize(list);
      renderRows();
      changed();
    },
    open,
    close: () => closePanel(false),
  };
}
