import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/js/effects.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../web/js/i18n.js', import.meta.url), 'utf8');
const en = i18n.slice(i18n.indexOf('  en: {'), i18n.indexOf('  ja: {'));

const catalogue = src.slice(src.indexOf('export const EFFECTS = ['), src.indexOf('const BY_ID'));
const post = [...catalogue.matchAll(/post\('(\w+)'/g)].map((m) => m[1]);
const params = (id) => {
  const start = catalogue.indexOf(`post('${id}'`);
  const end = catalogue.indexOf('\n  ]),', start);
  const block = catalogue.slice(start, end > 0 && end - start < 900 ? end : catalogue.indexOf('\n', start));
  return [...block.matchAll(/(?:range|color|select)\('(\w+)'/g)].map((m) => m[1]);
};

test('every post effect has a shader body, and every body belongs to an effect', () => {
  const bodies = [...src.matchAll(/^BODY\.(\w+) = `/gm)].map((m) => m[1]);
  assert.deepEqual(post.filter((id) => !bodies.includes(id)), []);
  assert.deepEqual(bodies.filter((id) => !post.includes(id)), []);
});

test('every shader body only reads params its effect declares (and the English labels exist)', () => {
  for (const id of post) {
    const start = src.indexOf(`BODY.${id} = \``) + `BODY.${id} = \``.length;
    const body = src.slice(start, src.indexOf('`;', start));
    const used = [...body.matchAll(/\bp([A-Z]\w*)\b/g)].map((m) => m[1].charAt(0).toLowerCase() + m[1].slice(1));
    const declared = params(id);
    for (const u of new Set(used)) assert.ok(declared.includes(u), `${id} reads p${u} but declares ${declared}`);
    assert.ok(en.includes(`"fx.${id}":`), `label for ${id}`);
    for (const d of declared) assert.ok(en.includes(`"fx.param.${d}":`), `label for ${id}.${d}`);
  }
});

test('select options of the focus lines each have a label', () => {
  const opts = catalogue.match(/select\('tone', \[([^\]]+)\]/)[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(opts, ['ink', 'white']);
  for (const o of opts) assert.ok(en.includes(`"fx.palette.${o}":`), o);
});

test('every select option of every effect has a label under fx.palette', () => {
  for (const m of catalogue.matchAll(/select\('(\w+)', \[([^\]]+)\]/g)) {
    for (const o of m[2].match(/'(\w+)'/g).map((x) => x.slice(1, -1))) assert.ok(en.includes(`"fx.palette.${o}":`), `${m[1]}: ${o}`);
  }
});
