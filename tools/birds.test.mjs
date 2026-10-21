import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BIRD_KINDS, birdChance, birdKind, birdParts, birdSpacing, flockSize } from '../web/js/birds.js';

const paris = { lat: 48.86, lon: 2.29 };
const tokyo = { lat: 35.66, lon: 139.7 };
const jakarta = { lat: -6.2, lon: 106.8 };

test('spacing: Europe has the most flocks, then Japan, then everywhere else', () => {
  const [p, t, j, none] = [paris, tokyo, jakarta, null].map(birdSpacing);
  assert.ok(p < t && t < j);
  assert.equal(j, none);
});

test('chance: percentage per sample, clamped, bad input is none', () => {
  assert.equal(birdChance(100, 50, 10), 0.2);
  assert.equal(birdChance(0, 50, 10), 0);
  assert.equal(birdChance(100, 5, 10), 1);
  assert.equal(birdChance(900, 50, 10), 0.2);
  assert.equal(birdChance('x', 50, 10), 0);
});

test('kind: chosen one wins; auto gives crows only in Japan and only below 45%', () => {
  assert.equal(birdKind('crow', paris, 0.9), 'crow');
  assert.equal(birdKind('pigeon', tokyo, 0), 'pigeon');
  assert.equal(birdKind('auto', tokyo, 0.2), 'crow');
  assert.equal(birdKind('auto', tokyo, 0.5), 'pigeon');
  assert.equal(birdKind('auto', paris, 0.0), 'pigeon');
  assert.equal(birdKind('toString', tokyo, 0.1), 'crow');
  assert.equal(birdKind('auto', null, 0), 'pigeon');
});

test('flock size: crows come alone or in pairs, pigeons in twos to sevens, and the extremes are reached', () => {
  const crows = new Set(Array.from({ length: 50 }, (_, i) => flockSize('crow', i / 50)));
  assert.deepEqual([...crows].sort(), [1, 2]);
  const pigeons = new Set(Array.from({ length: 60 }, (_, i) => flockSize('pigeon', i / 60)));
  assert.deepEqual([...pigeons].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  assert.equal(flockSize('pigeon', 5), 7);
  assert.equal(flockSize('pigeon', -1), 2);
  assert.equal(flockSize('pigeon', NaN), 2);
});

test('a bird stands on its legs, the head is ahead of the body, and pecking lowers the head', () => {
  for (const kind of ['pigeon', 'crow']) {
    const stand = birdParts(kind, 1, false);
    const peck = birdParts(kind, 1, true);
    for (const parts of [stand, peck]) {
      assert.equal(Math.min(...parts.map((b) => b.h0)), 0, `${kind}: legs reach the ground`);
      for (const b of parts) assert.ok(b.u0 < b.u1 && b.v0 < b.v1 && b.h0 < b.h1, `${kind} ${b.role}`);
      const body = parts.find((b) => b.role === 'body');
      const head = parts.find((b) => b.role === 'head');
      assert.ok(head.u0 >= body.u1 - 1e-9 - 0.05 && head.u1 > body.u1, `${kind}: head ahead of the body`);
      assert.ok(parts.find((b) => b.role === 'tail').u1 <= body.u0 + 0.05 * 1.5 + 1e-9, `${kind}: tail behind`);
    }
    const headTop = (p) => p.find((b) => b.role === 'head').h1;
    assert.ok(headTop(peck) < headTop(stand), `${kind}: head lower when pecking`);
  }
});

test('a crow is bigger than a pigeon, and size scales and clamps to 0.6..2.5', () => {
  const top = (parts) => Math.max(...parts.map((b) => b.h1));
  assert.ok(top(birdParts('crow')) > top(birdParts('pigeon')) * 1.4);
  assert.ok(Math.abs(top(birdParts('pigeon', 2)) / top(birdParts('pigeon', 1)) - 2) < 1e-9);
  assert.deepEqual(birdParts('pigeon', 99), birdParts('pigeon', 2.5));
  assert.deepEqual(birdParts('pigeon', 0), birdParts('pigeon', 1));
});

test('the kind options in the panel match the table', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="wBirdKind">(.*?)<\/select>/s);
  assert.ok(m, '#wBirdKind exists');
  assert.deepEqual([...m[1].matchAll(/value="([^"]+)"/g)].map((x) => x[1]), BIRD_KINDS);
});
