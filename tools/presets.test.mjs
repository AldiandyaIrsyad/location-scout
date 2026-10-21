import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PRESETS } from '../web/js/presets.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../web/index.html');
const effects = read('../web/js/effects.js');
const presetsSrc = read('../web/js/presets.js');

const list = (name) => {
  const start = presetsSrc.indexOf(`const ${name} = [`);
  return [...presetsSrc.slice(start, presetsSrc.indexOf('];', start)).matchAll(/'(\w+)'/g)].map((m) => m[1]);
};
const NUMERIC = list('NUMERIC');
const CHECKS = list('CHECKS');
const SELECTS = list('SELECTS');

// effect catalogue: id -> { param -> { min, max } or { options } }
const catalogue = effects.slice(effects.indexOf('export const EFFECTS = ['), effects.indexOf('const BY_ID'));
const catalog = new Map();
for (const m of catalogue.matchAll(/(?:post|world)\('(\w+)', (?:(?:true|false), )?\[([\s\S]*?)\]\),?\n/g)) {
  const params = new Map();
  for (const p of m[2].matchAll(/range\('(\w+)', (-?[\d.]+), (-?[\d.]+)/g)) params.set(p[1], { min: Number(p[2]), max: Number(p[3]) });
  for (const p of m[2].matchAll(/select\('(\w+)', \[([^\]]+)\]/g)) params.set(p[1], { options: p[2].match(/'(\w+)'/g).map((x) => x.slice(1, -1)) });
  for (const p of m[2].matchAll(/color\('(\w+)'/g)) params.set(p[1], { color: true });
  catalog.set(m[1], params);
}

const styles = [...html.matchAll(/data-style="([\w-]+)"/g)].map((m) => m[1]);

const control = (id) => {
  const m = html.match(new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`));
  return m ? m[0] : null;
};

test('preset ids are unique and each has a name and a known style', () => {
  const ids = PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PRESETS) {
    assert.ok(p.name, p.id);
    if (p.style) assert.ok(styles.includes(p.style), `${p.id}: style ${p.style} is not one of the style buttons ${styles}`);
  }
  assert.ok(ids.includes('manhwa') && ids.includes('classic'), 'the two focus presets exist');
});

test('every value a preset sets belongs to a control the preset code drives, and fits that control', () => {
  const driven = new Set([...NUMERIC, ...CHECKS, ...SELECTS, 'style']);
  for (const p of PRESETS) {
    for (const [key, v] of Object.entries(p.values || {})) {
      assert.ok(driven.has(key), `${p.id}: ${key} is not driven by the preset code`);
      const tag = control(key);
      if (typeof v === 'number' && tag) {
        const min = tag.match(/min="(-?[\d.]+)"/);
        const max = tag.match(/max="(-?[\d.]+)"/);
        if (min) assert.ok(v >= Number(min[1]), `${p.id}: ${key}=${v} below ${min[1]}`);
        if (max) assert.ok(v <= Number(max[1]), `${p.id}: ${key}=${v} above ${max[1]}`);
      }
    }
  }
});

test('select values a preset sets are options of that select', () => {
  for (const p of PRESETS) {
    for (const [key, v] of Object.entries(p.values || {})) {
      if (typeof v !== 'string' || !SELECTS.includes(key)) continue;
      const m = html.match(new RegExp(`id="${key}"[^>]*>([\\s\\S]*?)</select>`));
      if (!m) continue;
      const opts = [...m[1].matchAll(/value="([^"]*)"/g)].map((x) => x[1]);
      assert.ok(opts.includes(v), `${p.id}: ${key}="${v}" is not one of ${opts}`);
    }
  }
});

test('every effect in a preset exists, has strength 0..1 and only declares params in range', () => {
  assert.ok(catalog.size >= 25, `catalogue parsed (${catalog.size})`);
  for (const p of PRESETS) {
    for (const e of p.effects || []) {
      const params = catalog.get(e.id);
      assert.ok(params, `${p.id}: unknown effect ${e.id}`);
      assert.ok(e.strength >= 0 && e.strength <= 1, `${p.id}.${e.id}: strength ${e.strength}`);
      for (const [name, v] of Object.entries(e.params || {})) {
        const def = params.get(name);
        assert.ok(def, `${p.id}.${e.id}: unknown param ${name}`);
        if (def.min !== undefined) assert.ok(v >= def.min && v <= def.max, `${p.id}.${e.id}.${name}=${v} outside ${def.min}..${def.max}`);
        if (def.options) assert.ok(def.options.includes(v), `${p.id}.${e.id}.${name}=${v}`);
        if (def.color) assert.match(v, /^#[0-9a-f]{6}$/i);
      }
    }
  }
});

test('an effect appears at most once per preset', () => {
  for (const p of PRESETS) {
    const ids = (p.effects || []).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${p.id}: ${ids}`);
  }
});

test('the spring, rain and night presets drive the controls their look depends on', () => {
  const by = (id) => PRESETS.find((p) => p.id === id);
  assert.equal(by('manhwa-spring').values.season, 'spring');
  assert.ok(by('manhwa-spring').values.wLitter > 0, 'petals under the trees');
  assert.ok(by('manhwa-spring').effects.some((e) => e.id === 'petals'));
  assert.ok(by('manhwa-rain').values.wWet > 0 && by('manhwa-rain').values.wUmbrellas > 0);
  assert.ok(by('manhwa-rain').effects.some((e) => e.id === 'rain'));
  assert.ok(by('manhwa-night').values.wLamps > 0 && by('manhwa-night').effects.some((e) => e.id === 'night'));
});
