import assert from 'node:assert/strict';
import test from 'node:test';
import { courtKind, courtLayout, courtSurface, courtToLocal, pitchFrame } from '../web/js/courts.js';

const KINDS = ['basketball', 'football', 'futsal', 'tennis', 'volleyball', 'badminton', 'multi', 'generic'];
const rotated = (length, width, yaw, cx = 0, cy = 0) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
  const u = (a * length) / 2, v = (b * width) / 2;
  return [cx + u * Math.cos(yaw) - v * Math.sin(yaw), cy + u * Math.sin(yaw) + v * Math.cos(yaw)];
});

test('an unknown sport gets an outline only and a mixed pitch a centre line', () => {
  assert.equal(courtKind('soccer'), 'football');
  assert.equal(courtKind('beachvolleyball'), 'volleyball');
  assert.equal(courtKind('multi'), 'multi');
  assert.equal(courtKind('skateboard'), 'generic');
  assert.equal(courtLayout('generic', 30, 20).lines.length, 1);
  assert.equal(courtLayout('multi', 30, 20).lines.length, 2);
});

test('the surface tag wins over the sport colour, and no tags keep the grass colour', () => {
  const asphaltBasketball = courtSurface('basketball', 'asphalt');
  assert.notEqual(asphaltBasketball, courtSurface('basketball', ''), 'surface tag must change the colour');
  assert.equal(courtSurface('basketball', 'moon_dust'), courtSurface('basketball', ''), 'unknown surface falls back to the sport');
  assert.equal(courtSurface('', 'clay'), courtSurface('tennis', 'clay'), 'surface alone is enough');
  assert.equal(courtSurface('', ''), null);
  assert.equal(courtSurface('skateboard', ''), null);
});

test('markings stay inside the court at every size, and the court stays inside the mapped outline', () => {
  for (const kind of KINDS) {
    for (const [length, width] of [[120, 80], [34, 20], [12, 6], [300, 40]]) {
      const layout = courtLayout(kind, length, width);
      assert.ok(layout.length <= length * 0.92 + 1e-9 && layout.width <= width * 0.92 + 1e-9, `${kind} ${length}x${width} exceeds outline`);
      for (const line of layout.lines) {
        for (const [u, v] of line) {
          assert.ok(Math.abs(u) <= layout.length / 2 + 1e-6 && Math.abs(v) <= layout.width / 2 + 1e-6, `${kind} ${length}x${width}: (${u}, ${v}) outside the court`);
        }
      }
    }
  }
});

test('a court is not stretched beyond its standard size on a big pitch, but shrinks on a small one', () => {
  assert.ok(Math.abs(courtLayout('basketball', 60, 40).length - 28) < 1e-9);
  assert.ok(courtLayout('basketball', 20, 12).length < 28);
});

test('equipment stands at both ends facing in, and the net spans the court centre', () => {
  const hoops = courtLayout('basketball', 34, 20).props.filter((p) => p.type === 'hoop');
  assert.equal(hoops.length, 2);
  for (const h of hoops) assert.equal(Math.sign(h.dir), -Math.sign(h.u), 'a hoop faces the court centre');
  assert.notEqual(hoops[0].u, hoops[1].u);

  const goals = courtLayout('football', 100, 60).props.filter((p) => p.type === 'goal');
  assert.equal(goals.length, 2);
  assert.ok(goals.every((g) => g.width <= 7.32 && g.width <= 60 * 0.6), 'a goal never exceeds the pitch');

  const net = courtLayout('tennis', 30, 16).props.find((p) => p.type === 'net');
  assert.equal(net.u, 0);
  assert.ok(net.span <= 16);
  assert.equal(courtLayout('generic', 30, 20).props.length, 0);
});

test('pitchFrame recovers the long side whichever way the outline is drawn', () => {
  const along = pitchFrame(rotated(40, 20, 0.6, 15, -8));
  assert.ok(Math.abs(along.length - 40) < 0.1 && Math.abs(along.width - 20) < 0.1);
  assert.ok(Math.abs(along.cx - 15) < 0.1 && Math.abs(along.cy + 8) < 0.1);
  assert.ok(Math.abs(Math.sin(along.yaw) - Math.sin(0.6)) < 0.02 && Math.abs(Math.cos(along.yaw) - Math.cos(0.6)) < 0.02);

  // the same rectangle, drawn with its long side across: yaw turns a quarter so length is still the long side
  const across = pitchFrame(rotated(20, 40, 0.6, 15, -8));
  assert.ok(Math.abs(across.length - 40) < 0.1 && Math.abs(across.width - 20) < 0.1);
  assert.ok(Math.abs(Math.sin(across.yaw) - Math.sin(0.6 + Math.PI / 2)) < 0.02);
});

test('the court centre line ends on the middle of the outline\'s short sides', () => {
  const ring = rotated(40, 20, 0.6, 15, -8);
  const frame = pitchFrame(ring);
  const end = courtToLocal(frame, frame.length / 2, 0);
  const shortSideMiddles = [[0, 1], [2, 3], [1, 2], [3, 0]]
    .filter(([i, j]) => Math.abs(Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]) - 20) < 0.1)
    .map(([i, j]) => [(ring[i][0] + ring[j][0]) / 2, (ring[i][1] + ring[j][1]) / 2]);
  assert.equal(shortSideMiddles.length, 2);
  assert.ok(shortSideMiddles.some(([x, y]) => Math.hypot(x - end[0], y - end[1]) < 0.1), 'the +u end must be on a short side, not a long one');
});
