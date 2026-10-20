// A street-level viewpoint that faces the place itself: standing on a nearby street, eye height,
// looking at the scene centre. The server's viewpoints are chosen by street layout alone and may not
// show the subject at all; a manga background reference needs the subject seen from the street.
import { inArea } from './surfaces.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PATH_KINDS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor']);

function* along(points, step) {
  yield points[0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) yield [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n];
  }
}

export function subjectViewpoint(city, { eye = 1.6 } = {}) {
  const half = (city.size || 300) / 2;
  const buildings = (city.buildings || []).filter((b) => b.outer?.length >= 3 && b.height > 0);
  // The subject is whatever stands at the centre; its tallest part sets how far back to stand.
  const subject = new Set(buildings.filter((b) => inArea(0, 0, b) || b.outer.some((p) => Math.hypot(p[0], p[1]) < 40)));
  const height = [...subject].reduce((m, b) => Math.max(m, b.height), 12);
  const wanted = clamp(height * 1.3, 30, Math.max(30, Math.min(140, half * 0.9)));
  const atEye = (b) => (b.minHeight || 0) < eye;
  const insideBuilding = (x, y) => buildings.some((b) => atEye(b) && inArea(x, y, b));
  const blocked = (x, y) => buildings.some((b) => !subject.has(b) && b.height > eye && atEye(b) && inArea(x, y, b));

  let best = null;
  for (const road of city.roads || []) {
    if (!road.points || road.points.length < 2 || road.tunnel || road.bridge || road.layer > 0) continue;
    const path = PATH_KINDS.has(road.kind);
    for (const [x, y] of along(road.points, 5)) {
      const r = Math.hypot(x, y);
      if (r < 15 || Math.abs(r - wanted) > wanted * 0.6 || Math.abs(x) > half * 0.95 || Math.abs(y) > half * 0.95) continue;
      // Closest to the wanted distance wins; a drivable street beats a footpath on a tie.
      const score = Math.abs(r - wanted) / wanted + (path ? 0.02 : 0);
      if (best && score >= best.score) continue;
      if (insideBuilding(x, y)) continue;
      // The line of sight must not cross other buildings before it reaches the subject's own footprint.
      let clear = true;
      for (let k = 1; k <= 12 && clear; k++) {
        const t = k / 13, qx = x * (1 - t), qy = y * (1 - t);
        if (Math.hypot(qx, qy) >= Math.min(r * 0.5, 30) && blocked(qx, qy)) clear = false;
      }
      if (clear) best = { score, x, y };
    }
  }
  if (!best) return null;
  return {
    kind: 'street-subject', label: 'Street view · facing the centre',
    position: [best.x, best.y], target: [0, 0], eyeHeight: eye,
    lookHeight: clamp(height * 0.35, 2.5, 40),
  };
}
