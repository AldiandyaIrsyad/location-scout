import assert from 'node:assert/strict';
import test from 'node:test';
import { refitViewpoint, subjectViewpoint, viewpointAim } from '../web/js/street-view.js';

const box = (x0, y0, x1, y1, height, extra = {}) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: [], height, ...extra });
const road = (points, extra = {}) => ({ points, kind: 'residential', width: 6, ...extra });

function projectedVertex(vp, [x, y], height, groundAt = () => 0) {
  const [px, py] = vp.position, [tx, ty] = vp.target;
  const d = Math.hypot(tx - px, ty - py);
  const yaw = Math.atan2(tx - px, ty - py);
  const cameraGround = groundAt(px, py);
  const subjectGround = groundAt(tx, ty);
  const pitch = Math.atan2(vp.lookHeight - vp.eyeHeight + subjectGround - cameraGround, d);
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const right = [cy, 0, sy];
  const up = [-sy * sp, cp, cy * sp];
  const forward = [sy * cp, sp, -cy * cp];
  // World Z is -north, and the camera is at the returned road position.
  const delta = [x - px, subjectGround + height - (cameraGround + vp.eyeHeight), -y + py];
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const depth = dot(delta, forward);
  const tanV = Math.tan((vp.frame.fov * Math.PI) / 360);
  return {
    x: dot(delta, right) / (depth * tanV * vp.frame.aspect),
    y: dot(delta, up) / (depth * tanV),
  };
}

test('stands on a mapped street and aims at the measured subject centre from eye height', () => {
  const city = { size: 300, buildings: [box(-10, -10, 10, 10, 40)], roads: [road([[-120, -50], [120, -50]]), road([[-120, -130], [120, -130]])] };
  const vp = subjectViewpoint(city);
  assert.equal(vp.kind, 'street-subject');
  assert.deepEqual(vp.target, [0, 0]);
  assert.equal(vp.eyeHeight, 1.6);
  assert.ok(Math.hypot(...vp.position) < 80, 'a 40 m subject uses the nearby mapped street');
  assert.ok(vp.frame.fits, 'the measured subject fits the requested camera framing');
  assert.ok(vp.lookHeight > 2.5, 'a tall subject is aimed at above its base');
});

test('viewpointAim centres actual near/far vertical angles', () => {
  const aim = viewpointAim({ eye: 1.6, base: 0, top: 132, distance: 185, depth: 10 });
  assert.ok(Math.abs(aim.pitch - (aim.lower + aim.upper) / 2) < 1e-12, 'the returned pitch bisects the projected extrema');
  assert.ok(aim.lookHeight > 55 && aim.lookHeight < 70);
});

test('skips streets whose line of sight is walled off by another building', () => {
  const city = {
    size: 300, buildings: [box(-10, -10, 10, 10, 20), box(-60, -30, 60, -25, 30)],
    roads: [road([[-100, -45], [100, -45]]), road([[-100, 40], [100, 40]])],
  };
  const vp = subjectViewpoint(city);
  assert.ok(vp.position[1] > 0, 'the street behind the wall must not be chosen');
});

test('does not promote a nearby corner of a distant block to the central subject', () => {
  const city = {
    size: 300,
    buildings: [
      box(-5, -5, 5, 5, 30),
      box(20, 20, 200, 200, 330), // one corner is near the anchor, but the block is not centred there
    ],
    roads: [road([[-120, -50], [120, -50]])],
  };
  const vp = subjectViewpoint(city);
  assert.ok(vp.frame.requiredDistance < 100, 'the central 30 m building sets framing instead of the distant 330 m block');
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

test('uses viewport geometry and mapped context roads to fit a tall landmark', () => {
  const city = {
    size: 300,
    buildings: [box(-10, -10, 10, 10, 132)],
    // The detailed 300 m square has a road, but it is too close for a 132 m subject at 32 mm.
    roads: [road([[-140, 0], [140, 0]])],
  };
  const contextRoads = [road([[-420, 0], [420, 0]], { id: 'mapped-context' })];
  const vp = subjectViewpoint(city, { fov: 41.112, aspect: 1246 / 488, contextRoads });
  assert.equal(vp.eyeHeight, 1.6);
  assert.ok(vp.frame.contextRoad, 'the fitting road comes from mapped context');
  assert.ok(vp.frame.fits, 'the 132 m subject fits the 32 mm viewport');
  assert.ok(vp.frame.distance > 180, 'the required distance follows measured height and viewport FOV');
  assert.ok(vp.lookHeight > 50 && vp.lookHeight < 75, 'the aim is near the subject angular midpoint');
  assert.ok(vp.frame.requiredLens > 30 && vp.frame.requiredLens < 35, 'fit metadata reports the lens needed at the selected distance');
  for (const x of [-10, 10]) for (const y of [-10, 10]) for (const h of [0, 132]) {
    const p = projectedVertex(vp, [x, y], h);
    assert.ok(Math.abs(p.x) < 1 / vp.frame.margin && Math.abs(p.y) < 1 / vp.frame.margin,
      `vertex ${x},${y},${h} stays inside the margin (${p.x},${p.y})`);
  }
});

test('frame.fits also holds for a 330 m subject across near and far footprint vertices', () => {
  const city = {
    size: 300,
    buildings: [box(-20, -20, 20, 20, 330)],
    roads: [road([[-140, 0], [140, 0]])],
  };
  const vp = subjectViewpoint(city, {
    fov: 41.112,
    aspect: 1246 / 488,
    contextRoads: [road([[-700, 0], [700, 0]], { id: 'mapped-context' })],
  });
  assert.ok(vp.frame.fits);
  for (const x of [-20, 20]) for (const y of [-20, 20]) for (const h of [0, 330]) {
    const p = projectedVertex(vp, [x, y], h);
    assert.ok(Math.abs(p.x) < 1 / vp.frame.margin && Math.abs(p.y) < 1 / vp.frame.margin,
      `330 m vertex ${x},${y},${h} stays inside the margin (${p.x},${p.y})`);
  }
});

test('accepts custom landmark geometry and keeps the target off the map origin', () => {
  const city = {
    size: 300,
    buildings: [],
    roads: [road([[-100, -100], [100, -100]]), road([[-100, 100], [100, 100]])],
  };
  const vp = subjectViewpoint(city, {
    fov: 41.112,
    aspect: 2,
    subject: { center: [35, 20], height: 80, footprint: [[25, 10], [45, 10], [45, 30], [25, 30]] },
  });
  assert.deepEqual(vp.target, [35, 20]);
  assert.equal(vp.eyeHeight, 1.6);
  assert.ok(vp.frame.fits, 'custom footprint is included in the framing calculation');
  assert.ok(Math.hypot(vp.position[0] - 35, vp.position[1] - 20) > 90);
});

test('uses horizontal FOV from the viewport aspect when selecting a road', () => {
  const city = {
    size: 300,
    buildings: [],
    roads: [road([[-140, -100], [140, -100]]), road([[-140, 100], [140, 100]])],
  };
  const contextRoads = [road([[-400, -300], [400, -300]], { id: 'wide-context' })];
  const subject = { center: [0, 0], height: 20, footprint: [[-40, -5], [40, -5], [40, 5], [-40, 5]] };
  const narrow = subjectViewpoint(city, { fov: 41.112, aspect: 0.5, subject, contextRoads });
  const wide = subjectViewpoint(city, { fov: 41.112, aspect: 2.5, subject, contextRoads });
  assert.ok(narrow.frame.distance > wide.frame.distance + 100, 'a portrait viewport needs a farther mapped road for the same wide subject');
  assert.ok(narrow.frame.fits && wide.frame.fits);
});

test('reports when a 300 m detail square cannot fit a tall subject without changing lens or loading context', () => {
  const city = { size: 300, buildings: [box(-10, -10, 10, 10, 330)], roads: [road([[-140, 0], [140, 0]])] };
  const vp = subjectViewpoint(city, { fov: 41.112, aspect: 1246 / 488 });
  assert.ok(vp, 'an available mapped road is still returned');
  assert.equal(vp.frame.fits, false);
  assert.ok(vp.frame.requiredFov > 41.112, 'the result quantifies the wider FOV required to fit');
});

test('projects subject vertices correctly when the selected road is on sloped ground', () => {
  const city = {
    size: 300,
    buildings: [box(-8, -8, 8, 8, 80)],
    roads: [road([[-140, -100], [140, -100]]), road([[-140, 120], [140, 120]])],
  };
  // The camera road is 30 m above the subject ground. The returned lookHeight is relative to the
  // subject ground, so the renderer can add it to target terrain while retaining eye height on the road.
  const groundAt = (x, y) => y < -50 ? 30 : 0;
  const vp = subjectViewpoint(city, { fov: 41.112, aspect: 1246 / 488, groundAt });
  assert.equal(vp.frame.cameraGround, 30);
  assert.equal(vp.frame.subjectGround, 0);
  assert.equal(vp.frame.eyeRelative, 31.6);
  assert.ok(vp.frame.fits);
  for (const x of [-8, 8]) for (const y of [-8, 8]) for (const h of [0, 80]) {
    const p = projectedVertex(vp, [x, y], h, groundAt);
    assert.ok(Math.abs(p.x) < 1 / vp.frame.margin && Math.abs(p.y) < 1 / vp.frame.margin,
      `sloped-ground vertex ${x},${y},${h} stays inside the margin (${p.x},${p.y})`);
  }
});

test('refits an existing viewpoint without moving its mapped road position', () => {
  const city = {
    size: 300,
    buildings: [box(-8, -8, 8, 8, 80)],
    roads: [road([[-140, -100], [140, -100]]), road([[-140, 120], [140, 120]])],
  };
  const initial = subjectViewpoint(city, { fov: 41.112, aspect: 1246 / 488 });
  const groundAt = (x, y) => y < -50 ? 30 : 0;
  const refit = refitViewpoint(city, initial, { fov: 41.112, aspect: 1246 / 488, groundAt });
  assert.deepEqual(refit.position, initial.position);
  assert.deepEqual(refit.target, initial.target);
  assert.equal(refit.frame.cameraGround, groundAt(...initial.position));
  assert.ok(refit.frame.requiredFov > refit.frame.fov, 'the unchanged road now needs a wider lens on the slope');
  assert.notEqual(refit.lookHeight, initial.lookHeight, 'terrain changes the aim while preserving the road');
});

test('uses outside context buildings as line-of-sight obstacles without making them subjects', () => {
  const city = {
    size: 300,
    buildings: [box(-8, -8, 8, 8, 80)],
    roads: [],
  };
  const nearRoad = road([[-300, -120], [300, -120]], { id: 'near' });
  const farRoad = road([[-300, 220], [300, 220]], { id: 'far' });
  const outsideWall = box(-180, -95, 180, -45, 30, { id: 'outside-wall' });
  const vp = subjectViewpoint(city, {
    fov: 41.112,
    aspect: 2.5,
    contextRoads: [nearRoad, farRoad],
    obstacleBuildings: [outsideWall],
  });
  assert.ok(vp, 'the unobstructed context road remains usable');
  assert.ok(vp.position[1] > 0, 'the near context road behind the outside wall is rejected');
  assert.equal(vp.frame.contextRoad, true);
  assert.equal(vp.frame.verticalAngle < vp.frame.verticalLimit, true);
});

test('custom landmark geometry overrides an elevated map platform at the central anchor', () => {
  const city = {
    size: 300,
    // The mapped platform is only the lower visible deck. The rendered landmark starts at ground
    // level and continues to 330 m, so its supplied subject geometry must drive the camera aim.
    buildings: [box(-50, -50, 50, 50, 60, { minHeight: 57 })],
    roads: [road([[-140, 0], [140, 0]])],
  };
  const vp = subjectViewpoint(city, {
    fov: 41.112,
    aspect: 1246 / 488,
    subject: { center: [0, 0], baseHeight: 0, height: 330, radius: 89 },
    contextRoads: [road([[-700, 0], [700, 0]], { id: 'landmark-context' })],
  });
  assert.ok(vp.frame.contextRoad);
  assert.ok(vp.frame.distance > 400, 'the full model height determines the street distance');
  assert.ok(vp.lookHeight > 100, 'the aim stays above the model feet instead of centring the elevated deck');
  for (const h of [0, 330]) {
    const p = projectedVertex(vp, [0, 0], h);
    assert.ok(Math.abs(p.y) < 1 / vp.frame.margin, `model endpoint at ${h} m remains inside the frame (${p.y})`);
  }
});
