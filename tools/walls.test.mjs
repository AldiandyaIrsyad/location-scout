import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWallIndex, insideBuilding, nearestWall } from '../web/js/walls.js';

const square = { outer: [[0, 0], [10, 0], [10, 10], [0, 10]] };
const clockwise = { outer: [[20, 0], [20, 10], [30, 10], [30, 0]] }; // the other winding
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the nearest wall, its closest point and the normal pointing out of the building', () => {
  const idx = buildWallIndex([square]);
  const w = nearestWall(idx, 12, 5, 6);
  assert.ok(near(w.qx, 10) && near(w.qy, 5) && near(w.nx, 1) && near(w.ny, 0) && near(w.d, 2));
  const south = nearestWall(idx, 4, -1.5, 6);
  assert.ok(near(south.ny, -1) && near(south.nx, 0), 'the south wall faces south');
});

test('the normal points out whichever way the ring is wound', () => {
  const idx = buildWallIndex([clockwise]);
  const w = nearestWall(idx, 18, 5, 6);
  assert.ok(near(w.nx, -1) && near(w.ny, 0), 'the west wall of the clockwise building faces west');
});

test('inside a building there is no wall to stand against, and far from all walls there is none either', () => {
  const idx = buildWallIndex([square]);
  assert.equal(nearestWall(idx, 5, 5, 6), null);
  assert.equal(nearestWall(idx, 30, 30, 6), null);
  assert.equal(nearestWall(idx, 17, 5, 6), null, 'just beyond the search distance');
  assert.ok(nearestWall(idx, 16, 5, 6), 'exactly at it still counts');
});

test('between two buildings the closer wall wins, and at a corner the nearest point is the corner', () => {
  const idx = buildWallIndex([square, clockwise]);
  assert.ok(near(nearestWall(idx, 12, 5, 8).qx, 10), 'closer to the first');
  assert.ok(near(nearestWall(idx, 18, 5, 8).qx, 20), 'closer to the second');
  const corner = nearestWall(buildWallIndex([square]), 12, 12, 6);
  assert.ok(near(corner.qx, 10) && near(corner.qy, 10));
});

test('rings with fewer than three points and missing outlines are ignored', () => {
  assert.equal(buildWallIndex([{ outer: [[0, 0], [1, 1]] }, {}, null, undefined]).length, 0);
  assert.equal(buildWallIndex(undefined).length, 0);
  assert.equal(nearestWall([], 0, 0, 5), null);
});

test('insideBuilding follows the footprint, not its bounding box', () => {
  const l = { outer: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]] }; // an L shape
  const idx = buildWallIndex([l]);
  assert.equal(insideBuilding(idx, 2, 8), true);
  assert.equal(insideBuilding(idx, 8, 8), false, 'inside the box but outside the L');
  assert.equal(insideBuilding(idx, -1, -1), false);
});

test('the nearest wall also reports its building height, six metres when the height is unknown', () => {
  const idx = buildWallIndex([
    { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], height: 14 },
    { outer: [[30, 0], [40, 0], [40, 10], [30, 10]] },
  ]);
  assert.equal(nearestWall(idx, 5, -1, 3).height, 14);
  assert.equal(nearestWall(idx, 35, -1, 3).height, 6);
});
