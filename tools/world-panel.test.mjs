import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../web/index.html');
const world = read('../web/js/world.js');
const render = read('../web/js/render.js');

const table = (name) => {
  const start = world.indexOf(`const ${name} = [`);
  const end = world.indexOf('\n];', start);
  assert.ok(start > 0 && end > start, `${name} table found`);
  return [...world.slice(start, end).matchAll(/\['(\w+)', '(\w+)'/g)].map((m) => ({ id: m[1], key: m[2] }));
};
const sliders = table('SLIDERS');
const selects = table('SELECTS');
const checks = table('CHECKS');
const worldKeys = new Set([...render.slice(render.indexOf('const WORLD_KEYS'), render.indexOf(']);', render.indexOf('const WORLD_KEYS'))).matchAll(/'(\w+)'/g)].map((m) => m[1]));
const defaults = render.slice(render.indexOf('this.options = {'), render.indexOf('this.options = {') + 20000);

test('every control the World panel code reads exists in the page, once, and a slider has its output', () => {
  for (const { id } of [...sliders, ...selects, ...checks]) {
    const n = [...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length;
    assert.equal(n, 1, `#${id} appears ${n} times`);
  }
  for (const { id } of sliders) assert.ok(html.includes(`id="${id}Out"`), `#${id}Out for the slider readout`);
});

test('every control id in the page that starts with w and sits in the World panel is wired in world.js', () => {
  const wired = new Set([...sliders, ...selects, ...checks].map((c) => c.id));
  const start = html.indexOf('id="worldPop"');
  assert.ok(start > 0);
  const panel = html.slice(start, html.indexOf('</aside>', start) > 0 ? html.indexOf('</aside>', start) : undefined);
  const unwired = [...panel.matchAll(/<(?:input|select)[^>]*id="(w\w+)"/g)].map((m) => m[1]).filter((id) => !wired.has(id) && !/Out$/.test(id));
  // tree-mix and car boxes are wired through their own tables
  const own = unwired.filter((id) => !/^wMix|^wCar|^wSeed|^wFolHue|^wFolSat|^wFolLight/.test(id) && !world.includes(`'${id}'`));
  assert.deepEqual(own, []);
});

test('each option a control writes is a renderer default and rebuilds the scene (or is one of the live ones)', () => {
  // options that act through uniforms or per-frame reads instead of a rebuild
  const live = new Set(['skyScreentone', 'skyScreentoneReach', 'wetStreets', 'puddleSize', 'cloudCover', 'cloudScale', 'cloudSoft', 'cloudShade', 'cloudStyle', 'cloudDark', 'skyPalette', 'skyHaze', 'skyGlow', 'foliageSat', 'foliageHue', 'foliageLight', 'shadowTint', 'shadowTintAmt', 'edgeLines', 'lampDensity',
    // the window, wall and ground looks are shader uniforms
    'windowVariety', 'windowCurtains', 'windowReflection', 'windowFrames', 'wallWeathering', 'paveJoints', 'paveSlab', 'roadWear']);
  const missing = [];
  for (const { id, key } of [...sliders, ...selects, ...checks]) {
    if (!new RegExp(`\\b${key}\\b`).test(defaults) && !live.has(key)) missing.push(`${id} -> ${key} has no renderer default`);
    if (!worldKeys.has(key) && !live.has(key)) missing.push(`${id} -> ${key} is not in WORLD_KEYS`);
  }
  assert.deepEqual(missing, []);
});

test('the Street furniture groups hold their controls inside the section and keep the panel balanced', () => {
  const sec = html.slice(html.indexOf('h.worldFurniture'), html.indexOf('h.worldPeople'));
  // the slice runs from this section's heading to the next one's: its own close and the next section's open cancel out
  assert.equal((sec.match(/<details/g) || []).length, (sec.match(/<\/details>/g) || []).length, 'balanced details');
  const subs = [...sec.matchAll(/<details class="wsub"><summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.ok(subs.length >= 3, `groups: ${subs}`);
  for (const id of ['wBikes', 'wCafes', 'wAds', 'wLamps', 'wAwning']) assert.ok(sec.includes(`id="${id}"`), id);
});
