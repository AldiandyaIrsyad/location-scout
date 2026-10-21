// A street-level viewpoint that faces the place itself: standing on a nearby street, eye height,
// looking at the scene centre. The server's viewpoints are chosen by street layout alone and may not
// show the subject at all; a manga background reference needs the subject seen from the street.
import { inArea } from './surfaces.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PATH_KINDS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor']);
const DEG = Math.PI / 180;
const DEFAULT_FOV = 41.112; // renderer's 32 mm lens (vertical FOV, in degrees)

function* along(points, step) {
  if (!points?.length) return;
  yield points[0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) yield [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n];
  }
}

const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const point = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))
  ? [Number(p[0]), Number(p[1])] : null;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function validBuildings(city) {
  return (city.buildings || []).filter((b) => b.outer?.length >= 3 && Number(b.height) > 0);
}

function groundSampler(groundAt) {
  if (typeof groundAt !== 'function') return () => 0;
  return (x, y) => {
    try {
      const value = Number(groundAt(x, y));
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
}

function centralSubject(buildings, centre) {
  // A nearby vertex is not enough to call a building the subject: a large city block or a tower
  // can have one corner near the origin while the actual subject is elsewhere. Prefer footprints
  // containing the anchor; only when the anchor is open ground, use the nearest small cluster.
  const containing = buildings.filter((b) => inArea(centre[0], centre[1], b));
  if (containing.length) return new Set(containing);
  const centroidDistance = (b) => {
    const c = b.outer.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1]], [0, 0]);
    return distance([c[0] / b.outer.length, c[1] / b.outer.length], centre);
  };
  const ranked = buildings.map((b) => ({ b, d: centroidDistance(b) }));
  const nearest = ranked.reduce((m, item) => Math.min(m, item.d), Infinity);
  if (!Number.isFinite(nearest) || nearest > 40) return new Set();
  return new Set(ranked.filter(({ d }) => d <= Math.min(40, nearest + 8)).map(({ b }) => b));
}

function subjectInfo(buildings, options) {
  const supplied = options.subject || {};
  const centre = point(supplied.center || supplied.target) || [0, 0];
  const selected = centralSubject(buildings, centre);
  const rings = Array.isArray(supplied.footprint) ? [supplied.footprint]
    : Array.isArray(supplied.outer) ? [supplied.outer]
      : [...selected].map((b) => b.outer);
  const footprint = rings.flatMap((ring) => (ring || []).map(point).filter(Boolean));

  let base = Number.isFinite(Number(supplied.baseHeight)) ? Number(supplied.baseHeight) : 0;
  let top = Number.isFinite(Number(supplied.topHeight)) ? Number(supplied.topHeight) : NaN;
  if (!Number.isFinite(top) && Number.isFinite(Number(supplied.height))) {
    // `height` is the mapped model's top above its local ground, matching building.height.
    top = Number(supplied.height);
  }
  if (!Number.isFinite(top)) {
    top = [...selected].reduce((m, b) => Math.max(m, Number(b.height) || 0), 12);
    const mins = [...selected].map((b) => Number.isFinite(Number(b.minHeight)) ? Number(b.minHeight) : 0);
    if (mins.length) base = Math.min(...mins);
  }
  top = Math.max(top, base + 0.1);

  // No footprint is still useful for ordinary buildings, but a supplied radius gives custom
  // landmark models a conservative lateral bound without making this module know their mesh.
  const radius = Number.isFinite(Number(supplied.radius)) ? Math.max(0, Number(supplied.radius))
    : footprint.reduce((m, p) => Math.max(m, distance(p, centre)), 0);
  return { centre, selected, footprint, base, top, radius };
}

function horizontalBounds(subject, forward) {
  const right = [forward[1], -forward[0]];
  let lateral = subject.footprint.length ? 0 : subject.radius;
  let depth = subject.footprint.length ? 0 : subject.radius;
  for (const p of subject.footprint) {
    const d = [p[0] - subject.centre[0], p[1] - subject.centre[1]];
    lateral = Math.max(lateral, Math.abs(d[0] * right[0] + d[1] * right[1]));
    depth = Math.max(depth, Math.abs(d[0] * forward[0] + d[1] * forward[1]));
  }
  return { lateral, depth };
}

/**
 * Return the vertical aim that centres a subject's nearest and farthest base/top angles.
 * Distances are measured from the camera to the subject centre; `depth` is a horizontal half
 * extent. This is pure so camera callers and tests can use the same perspective calculation.
 */
export function viewpointAim({ eye = 1.6, base = 0, top = 12, distance: range, depth = 0 }) {
  const e = finite(eye, 1.6), b = finite(base, 0), t = finite(top, 12);
  const d = Math.max(0.1, finite(range, 0.1));
  const near = Math.max(0.1, d - Math.max(0, finite(depth, 0)));
  const far = Math.max(near, d + Math.max(0, finite(depth, 0)));
  const angles = [near, far].flatMap((distance) => [
    Math.atan2(b - e, distance),
    Math.atan2(t - e, distance),
  ]);
  const lower = Math.min(...angles), upper = Math.max(...angles);
  const pitch = (lower + upper) / 2;
  return {
    lower, upper, verticalAngle: upper - lower, pitch,
    lookHeight: e + Math.tan(pitch) * d,
    near, far,
  };
}

function frameAt(subject, eye, fov, aspect, margin, camera, d) {
  const vfov = fov * DEG;
  const tanV = Math.tan(vfov / 2);
  const hfov = 2 * Math.atan(tanV * aspect);
  const { lateral, depth } = horizontalBounds(subject, camera.forward);
  const aim = viewpointAim({ eye, base: subject.base, top: subject.top, distance: d, depth });
  const near = aim.near;
  const verticalAngle = Math.max(0, aim.verticalAngle);
  const horizontalAngle = 2 * Math.atan2(lateral, near);
  const verticalLimit = vfov / margin;
  const horizontalLimit = hfov / margin;
  const lookHeight = clamp(aim.lookHeight, Math.max(2.5, subject.base + 0.5), Math.max(2.5, subject.top - 0.5));
  return {
    fov, aspect, hfov: hfov / DEG, margin,
    distance: d, requiredDistance: 0,
    verticalAngle: verticalAngle / DEG, horizontalAngle: horizontalAngle / DEG,
    verticalLimit: verticalLimit / DEG, horizontalLimit: horizontalLimit / DEG,
    lookHeight, fits: verticalAngle <= verticalLimit && horizontalAngle <= horizontalLimit,
  };
}

function requiredVerticalDistance(subject, eye, fov, margin, depth = 0) {
  const limit = (fov * DEG) / margin;
  // If both ends are above (or below) the eye, the angular span first rises and then falls. Start
  // the binary search on the far side of that peak so the selected root is the useful far root.
  const a = subject.top - eye, b = subject.base - eye;
  const span = (d) => {
    const near = Math.max(0.1, d - depth);
    return Math.atan2(a, near) - Math.atan2(b, near);
  };
  const peak = a * b > 0 ? Math.sqrt(Math.abs(a * b)) : 0.1;
  let lo = depth + Math.max(0.1, peak), hi = Math.max(lo * 2, 10);
  if (span(lo) <= limit) return depth + 0.1;
  while (span(hi) > limit && hi < 1e7) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (span(mid) > limit) lo = mid; else hi = mid;
  }
  return hi;
}

function requiredDistance(subject, eye, fov, aspect, margin) {
  const vertical = requiredVerticalDistance(subject, eye, fov, margin, subject.radius);
  const tanH = Math.tan(Math.atan(Math.tan((fov * DEG) / 2) * aspect));
  // Worst-case lateral radius is conservative for an arbitrary road bearing. The selected road
  // is checked again with its actual projected footprint below.
  const horizontal = subject.radius / Math.max(1e-6, tanH) + subject.radius;
  return Math.max(30, vertical, margin * horizontal);
}

function roadsFor(city, options) {
  const local = (city.roads || []).map((road) => ({ road, context: false }));
  const context = [...(city.contextRoads || []), ...(options.contextRoads || [])].map((road) => ({ road, context: true }));
  const maxRoadDistance = Number.isFinite(Number(options.maxRoadDistance)) ? Math.max(15, Number(options.maxRoadDistance)) : Infinity;
  const centre = options.centre || [0, 0];
  return [...local, ...context].filter(({ road, context: outside }) => {
    if (!road.points || road.points.length < 2 || road.tunnel || road.bridge || road.layer > 0) return false;
    // Keep complete mapped polylines even when both endpoints are outside the square: a road can
    // cross the usable area between those endpoints. Candidate points receive the actual bounds.
    if (outside && Number.isFinite(maxRoadDistance)) return road.points.some((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1]) <= maxRoadDistance)
      || road.points.some((p, i) => i && Math.min(Math.hypot(p[0] - centre[0], p[1] - centre[1]), Math.hypot(road.points[i - 1][0] - centre[0], road.points[i - 1][1] - centre[1])) <= maxRoadDistance);
    return true;
  });
}

function frameForPosition(info, position, target, settings, groundAt) {
  const d = distance(position, target);
  if (!(d > 0)) return null;
  const cameraGround = groundAt(position[0], position[1]);
  const subjectGround = groundAt(target[0], target[1]);
  const relativeEye = settings.eye + cameraGround - subjectGround;
  const forward = [(target[0] - position[0]) / d, (target[1] - position[1]) / d];
  const frame = frameAt(info, relativeEye, settings.fov, settings.aspect, settings.margin, { forward }, d);
  frame.requiredDistance = requiredDistance(info, relativeEye, settings.fov, settings.aspect, settings.margin);
  frame.cameraGround = cameraGround;
  frame.subjectGround = subjectGround;
  frame.eyeRelative = relativeEye;
  return frame;
}

/**
 * Choose a mapped road position from which the central subject can be framed.
 *
 * `fov` and `aspect` are the renderer's current vertical FOV and viewport aspect. `subject` may
 * describe a custom landmark (`center`, `height`/`topHeight`, and `footprint` or `radius`); this
 * keeps the camera independent of any particular landmark registry. `contextRoads` can contain
 * mapped roads loaded outside the detailed square. The returned `frame` says whether the available
 * road actually fits, so callers can load context or select a wider lens instead of silently cropping.
 * `obstacleBuildings` participates in clearance checks while `groundAt(x, y)` lets framing account
 * for the difference between camera and subject terrain; returned `lookHeight` is relative to the
 * subject ground.
 */
export function subjectViewpoint(city, {
  eye = 1.6,
  fov = DEFAULT_FOV,
  aspect = 1,
  margin = 1.08,
  subject = null,
  contextRoads = [],
  maxRoadDistance = Infinity,
  obstacleBuildings = [],
  groundAt = null,
} = {}) {
  const half = (city.size || 300) / 2;
  const buildings = validBuildings(city);
  const nearIDs = new Set(buildings.filter(b => b.id).map(b => b.id));
  const obstacles = validBuildings({ buildings: obstacleBuildings }).filter(b => !b.id || !nearIDs.has(b.id));
  const blockerBuildings = [...new Set([...buildings, ...obstacles])];
  const sampleGround = groundSampler(groundAt);
  const settings = {
    eye: Math.max(0.1, finite(eye, 1.6)),
    fov: clamp(finite(fov, DEFAULT_FOV), 5, 170),
    aspect: clamp(finite(aspect, 1), 0.1, 10),
    margin: clamp(finite(margin, 1.08), 1, 2),
    subject: subject || {}, contextRoads, maxRoadDistance, centre: point(subject?.center || subject?.target) || [0, 0],
  };
  const info = subjectInfo(buildings, settings);
  const insideBuilding = (x, y) => blockerBuildings.some((b) => (b.minHeight || 0) < settings.eye && Number(b.height) > settings.eye && inArea(x, y, b));
  const blocked = (x, y) => blockerBuildings.some((b) => !info.selected.has(b) && Number(b.height) > settings.eye
    && (b.minHeight || 0) < settings.eye && inArea(x, y, b));
  const available = roadsFor(city, settings);

  let best = null;
  for (const { road, context } of available) {
    const path = PATH_KINDS.has(road.kind);
    for (const [x, y] of along(road.points, 5)) {
      const r = Math.hypot(x - info.centre[0], y - info.centre[1]);
      if (r < 15 || r > settings.maxRoadDistance || (Math.abs(x) > half * 0.95 && !context) || (Math.abs(y) > half * 0.95 && !context)) continue;
      const frame = frameForPosition(info, [x, y], info.centre, settings, sampleGround);
      if (!frame) continue;
      // A fitting viewpoint wins over a closer crop. Among fitting roads, stay near the computed
      // distance; if none fit, the farthest usable mapped road is preferred and frame.fits is false.
      const fitPenalty = frame.fits ? 0 : Math.max(
        frame.verticalAngle / frame.verticalLimit,
        frame.horizontalAngle / frame.horizontalLimit,
      ) - 1;
      const distancePenalty = Math.abs(Math.log(Math.max(1, r) / Math.max(1, frame.requiredDistance)));
      const score = fitPenalty * 4 + distancePenalty + (path ? 0.02 : 0) + (context ? 0.001 : 0);
      if (best && ((!frame.fits && best.frame.fits) || (frame.fits === best.frame.fits && score >= best.score))) continue;
      if (insideBuilding(x, y)) continue;
      const stop = Math.max(info.radius, 6);
      let clear = true;
      for (let k = 1; k <= 16 && clear; k++) {
        const t = k / 17, qx = x * (1 - t) + info.centre[0] * t, qy = y * (1 - t) + info.centre[1] * t;
        if (Math.hypot(qx - info.centre[0], qy - info.centre[1]) >= stop && blocked(qx, qy)) clear = false;
      }
      if (clear) best = { score, x, y, frame, context };
    }
  }
  if (!best) return null;

  const requiredHorizontal = best.frame.horizontalAngle * settings.margin * DEG;
  const requiredFov = Math.max(best.frame.verticalAngle * settings.margin,
    (2 * Math.atan(Math.tan(requiredHorizontal / 2) / settings.aspect)) / DEG);
  return {
    kind: 'street-subject', label: 'Street view · facing the centre',
    position: [best.x, best.y], target: info.centre, eyeHeight: settings.eye,
    lookHeight: best.frame.lookHeight,
    frame: { ...best.frame, requiredFov, requiredLens: 12 / Math.tan((requiredFov * DEG) / 2), contextRoad: best.context },
  };
}

/**
 * Recompute only the framing metadata for an existing viewpoint. This keeps a selected road
 * position stable when the viewport changes, while allowing terrain and custom subject geometry
 * to update the aim and fit report without another road search.
 */
export function refitViewpoint(city, viewpoint, {
  eye = viewpoint?.eyeHeight ?? 1.6,
  fov = DEFAULT_FOV,
  aspect = 1,
  margin = 1.08,
  subject = null,
  groundAt = null,
} = {}) {
  const position = point(viewpoint?.position);
  if (!position) return null;
  const requestedTarget = point(viewpoint?.target);
  const buildings = validBuildings(city);
  const settings = {
    eye: Math.max(0.1, finite(eye, 1.6)),
    fov: clamp(finite(fov, DEFAULT_FOV), 5, 170),
    aspect: clamp(finite(aspect, 1), 0.1, 10),
    margin: clamp(finite(margin, 1.08), 1, 2),
    subject: subject || { center: requestedTarget || [0, 0] },
  };
  const info = subjectInfo(buildings, settings);
  const target = info.centre;
  const frame = frameForPosition(info, position, target, settings, groundSampler(groundAt));
  if (!frame) return null;
  const requiredHorizontal = frame.horizontalAngle * settings.margin * DEG;
  const requiredFov = Math.max(frame.verticalAngle * settings.margin,
    (2 * Math.atan(Math.tan(requiredHorizontal / 2) / settings.aspect)) / DEG);
  return {
    ...viewpoint,
    kind: viewpoint?.kind || 'street-subject',
    position: [...position], target: [...target], eyeHeight: settings.eye,
    lookHeight: frame.lookHeight,
    frame: { ...frame, requiredFov, requiredLens: 12 / Math.tan((requiredFov * DEG) / 2), contextRoad: viewpoint?.frame?.contextRoad ?? false },
  };
}
