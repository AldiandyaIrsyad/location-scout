import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { AD_STYLES, POSTER_CHOICES, POSTER_PALETTES, adChance, adKind, adSpacing, posterColour, posterParts } from '../web/js/posters.js';

const paris = { lat: 48.86, lon: 2.29 };
const berlin = { lat: 52.5, lon: 13.4 };
const tokyo = { lat: 35.66, lon: 139.7 };
const nyc = { lat: 40.7, lon: -74 };

test('spacing: France first, then the rest of Europe, then Japan, then everywhere else', () => {
  const s = [paris, berlin, tokyo, nyc].map(adSpacing);
  assert.ok(s[0] < s[1] && s[1] < s[2] && s[2] < s[3]);
  assert.equal(adSpacing(null), s[3]);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(adChance(100, 50, 10), 0.2);
  assert.equal(adChance(0, 50, 10), 0);
  assert.equal(adChance(100, 5, 10), 1);
  assert.equal(adChance(900, 50, 10), 0.2);
  assert.equal(adChance('x', 50, 10), 0);
});

test('kind: columns in Europe and panels elsewhere under auto; a chosen kind always wins', () => {
  assert.deepEqual([paris, berlin, tokyo, nyc, null].map((c) => adKind('auto', c)), ['column', 'column', 'panel', 'panel', 'panel']);
  assert.equal(adKind('panel', paris), 'panel');
  assert.equal(adKind('column', tokyo), 'column');
  assert.equal(adKind('toString', paris), 'column');
});

test('poster colours: a palette only draws its own colours, mixed draws from all of them, unknown is mixed', () => {
  for (const [name, set] of Object.entries(POSTER_PALETTES)) {
    for (let i = 0; i < 40; i++) assert.ok(set.includes(posterColour(name, i / 40)), name);
    assert.equal(new Set(Array.from({ length: 60 }, (_, i) => posterColour(name, i / 60))).size, set.length, `${name} reaches each colour`);
  }
  const all = new Set(Object.values(POSTER_PALETTES).flat());
  const mixed = new Set(Array.from({ length: 200 }, (_, i) => posterColour('mixed', i / 200)));
  assert.equal(mixed.size, all.size);
  assert.equal(posterColour('toString', 0.3), posterColour('mixed', 0.3));
  assert.equal(posterColour('warm', 7), posterColour('warm', 0.999));
});

test('a column stacks base, poster band, cap and top from the ground up and is wider at the base than at its roof', () => {
  const p = posterParts('column', 1);
  assert.ok(p.sectors >= 6 && p.boxes.length === 0);
  assert.equal(p.rings[0].h0, 0);
  for (let i = 1; i < p.rings.length; i++) assert.ok(Math.abs(p.rings[i].h0 - p.rings[i - 1].h1) < 1e-9, `ring ${i} sits on the one below`);
  const band = p.rings.filter((r) => r.role === 'band');
  assert.equal(band.length, 1);
  assert.ok(band[0].h1 - band[0].h0 > 1.2, 'the poster band is tall enough to read');
  assert.ok(p.rings.at(-1).r < p.rings[0].r);
  assert.ok(p.rings.at(-1).h1 > 2.4 && p.rings.at(-1).h1 < 3.2);
});

test('a panel has a poster on each face, standing on legs, and the faces point away from each other', () => {
  const p = posterParts('panel', 1);
  assert.equal(p.rings.length, 0);
  const posters = p.boxes.filter((b) => b.role === 'poster');
  assert.equal(posters.length, 2);
  assert.ok(posters[0].v0 * posters[1].v0 > 0 === false, 'one in front, one behind');
  const frame = p.boxes.find((b) => b.role === 'frame');
  assert.ok(posters.every((b) => b.u0 > frame.u0 && b.u1 < frame.u1 && b.h0 > frame.h0 && b.h1 < frame.h1), 'posters inside the frame');
  assert.equal(Math.min(...p.boxes.map((b) => b.h0)), 0);
  assert.ok(p.boxes.filter((b) => b.h0 === 0).length >= 2, 'at least two legs');
});

test('size scales and clamps to 0.7..1.5', () => {
  const top = (p) => Math.max(...p.rings.map((r) => r.h1));
  assert.ok(Math.abs(top(posterParts('column', 1.5)) / top(posterParts('column', 1)) - 1.5) < 1e-9);
  assert.deepEqual(posterParts('column', 9), posterParts('column', 1.5));
  assert.deepEqual(posterParts('panel', 0), posterParts('panel', 1));
});

test('the style and palette options in the panel match the tables', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const opts = (id) => {
    const m = html.match(new RegExp(`id="${id}">(.*?)</select>`, 's'));
    assert.ok(m, `#${id} exists`);
    return [...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(opts('wAdStyle'), AD_STYLES);
  assert.deepEqual(opts('wPosterColour'), POSTER_CHOICES);
});
