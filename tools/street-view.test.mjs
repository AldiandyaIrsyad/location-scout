import assert from 'node:assert/strict';
import test from 'node:test';
import { subjectViewpoint } from '../web/js/street-view.js';

const box = (x0, y0, x1, y1, height, extra = {}) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: [], height, ...extra });
const road = (points, extra = {}) => ({ points, kind: 'residential', width: 6, ...extra });

test('stands on a street at a distance that suits the subject and faces the centre at eye height', () => {
  const city = { size: 300, buildings: [box(-10, -10, 10, 10, 40)], roads: [road([[-120, -50], [120, -50]]), road([[-120, -130], [120, -130]])] };
  const vp = subjectViewpoint(city);
  assert.equal(vp.kind, 'street-subject');
  assert.deepEqual(vp.target, [0, 0]);
  assert.equal(vp.eyeHeight, 1.6);
  assert.ok(Math.abs(Math.hypot(...vp.position) - 52) < 12, 'a 40 m subject is viewed from about 52 m, not from the far street');
  assert.ok(vp.lookHeight > 2.5, 'a tall subject is aimed at above its base');
});

test('skips streets whose line of sight is walled off by another building', () => {
  const city = {
    size: 300, buildings: [box(-10, -10, 10, 10, 20), box(-60, -30, 60, -25, 30)],
    roads: [road([[-100, -45], [100, -45]]), road([[-100, 40], [100, 40]])],
  };
  const vp = subjectViewpoint(city);
  assert.ok(vp.position[1] > 0, 'the street behind the wall must not be chosen');
});

test('never places the eye inside a building, or on tunnels, bridges and raised ways', () => {
  const city = {
    size: 300, buildings: [box(-10, -10, 10, 10, 20), box(-100, -40, 100, -30, 15)],
    roads: [road([[-100, -35], [100, -35]]), road([[-100, 45], [100, 45]], { bridge: true }), road([[-100, 50], [100, 50]], { tunnel: true })],
  };
  assert.equal(subjectViewpoint(city), null);
});

test('returns null when there is no street near enough', () => {
  assert.equal(subjectViewpoint({ size: 300, buildings: [], roads: [] }), null);
});
