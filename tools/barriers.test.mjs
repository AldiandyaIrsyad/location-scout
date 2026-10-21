import assert from 'node:assert/strict';
import test from 'node:test';
import { barrierHeight, barrierRuns, fixtureFacing, roadIndex } from '../web/js/barriers.js';
import { composeContext } from '../web/js/context.js';

const road = (points, extra = {}) => ({ points, width: 6, kind: 'residential', ...extra });
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('only the paved width of a surface road counts as a road', () => {
  const index = roadIndex([
    road([[-100, 0], [100, 0]]),
    road([[0, 50], [100, 50]], { bridge: true }),
    road([[0, 60], [100, 60]], { tunnel: true }),
    road([[0, 70], [100, 70]], { layer: 1 }),
    { points: [[0, 80], [100, 80]], kind: 'rail' }, // a railway has no width
  ]);
  assert.equal(index.insideRoad(10, 0), true);
  assert.equal(index.insideRoad(10, 2.6), true);
  assert.equal(index.insideRoad(10, 2.8), false, 'the outer 0.3 m of the road edge is left to barriers mapped along it');
  assert.equal(index.insideRoad(10, 5), false);
  for (const y of [50, 60, 70, 80]) assert.equal(index.insideRoad(10, y), false, `y=${y}`);
});

test('a fence crossing a road leaves an opening about as wide as the road; one along it stays whole', () => {
  const index = roadIndex([road([[0, -50], [0, 50]])]);
  const across = barrierRuns([[-30, 0], [30, 0]], index.insideRoad);
  assert.equal(across.length, 2);
  const gap = across[1][0][0] - across[0].at(-1)[0];
  assert.ok(gap > 4.5 && gap < 8.5, `gap ${gap} m for a 6 m road`);

  const along = barrierRuns([[3.2, -40], [3.2, 40]], index.insideRoad);
  assert.equal(along.length, 1);
  assert.deepEqual([along[0][0], along[0].at(-1)], [[3.2, -40], [3.2, 40]]);
});

test('barrier runs keep the line\'s own corners and drop single stray samples', () => {
  const runs = barrierRuns([[0, 0], [10, 0], [10, 10]], () => false, 4);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].some(([x, y]) => x === 10 && y === 0), 'the corner stays a vertex');
  const lone = barrierRuns([[0, 0], [10, 0]], (x) => x < 9, 4);
  assert.deepEqual(lone, [], 'one sample left outside the road is not a barrier');
});

test('a tagged compass direction wins; otherwise a fixture faces the nearest road, else a stable quarter turn', () => {
  const index = roadIndex([road([[-50, 0], [50, 0]])]);
  assert.ok(near(fixtureFacing({ id: 'n1', position: [0, 10], direction: 0 }, index), Math.PI / 2), 'north is +y');
  assert.ok(near(fixtureFacing({ id: 'n1', position: [0, 10], direction: 90 }, index), 0), 'east is +x');

  // south of an east-west road, a bench faces north toward it; north of it, south
  assert.ok(near(fixtureFacing({ id: 'n2', position: [5, -8] }, index), Math.PI / 2));
  assert.ok(near(fixtureFacing({ id: 'n3', position: [5, 8] }, index), -Math.PI / 2));

  const far = { id: 'n4', position: [0, 200] };
  const a = fixtureFacing(far, index);
  assert.equal(a, fixtureFacing(far, index), 'the fallback must not change between builds');
  assert.ok(near(a / (Math.PI / 2), Math.round(a / (Math.PI / 2))), 'a quarter turn');
});

test('mapped heights are clamped and untagged ones come from the kind', () => {
  assert.equal(barrierHeight({ kind: 'fence', height: 2.4 }), 2.4);
  assert.equal(barrierHeight({ kind: 'fence', height: 400 }), 12);
  assert.equal(barrierHeight({ kind: 'hedge', height: 0.01 }), 0.3);
  assert.ok(barrierHeight({ kind: 'wall' }) > barrierHeight({ kind: 'retaining_wall' }));
  assert.equal(barrierHeight({ kind: 'moat' }), 0);
});

test('surroundings add only the barrier length outside the detailed square', () => {
  const inside = { id: 'w1', kind: 'fence', points: [[-50, 0], [50, 0]] };
  const city = { size: 300, barriers: [inside], fixtures: [{ id: 'n1' }], roads: [], railways: [] };
  const through = { id: 'w9', kind: 'wall', points: [[-500, 0], [500, 0]] }; // also crosses the inside
  const ctx = composeContext(city, { contextSize: 2000, barriers: [through] });
  assert.equal(ctx.barriers[0], inside);
  const outer = ctx.barriers.slice(1);
  assert.equal(outer.length, 2, 'the wall is kept on both sides of the square');
  assert.ok(outer.every((b) => b.context && b.points.every(([x]) => Math.abs(x) >= 180 - 1e-9)));
  assert.deepEqual(ctx.fixtures, [{ id: 'n1' }]);
  assert.deepEqual(composeContext({ size: 300 }, null).barriers, []);
});
