// Where the building walls are, so street objects (vending machines, signs, ...) can stand against them
// instead of inside them. Pure geometry, no rendering.

/** Index of the outer rings of `buildings` ({ outer: [[x, y], ...] }) with their bounding boxes. */
export function buildWallIndex(buildings) {
  const items = [];
  for (const b of buildings || []) {
    const ring = b && b.outer;
    if (!ring || ring.length < 3) continue;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of ring) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
    items.push({ ring, minx, miny, maxx, maxy, height: Number.isFinite(b.height) ? b.height : 6, building: b });
  }
  return items;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[i];
    const b = ring[k];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** True when (x, y) is inside any building. */
export function insideBuilding(index, x, y) {
  for (const it of index) {
    if (x < it.minx || x > it.maxx || y < it.miny || y > it.maxy) continue;
    if (inRing(x, y, it.ring)) return true;
  }
  return false;
}

/**
 * The wall nearest to (x, y) within `maxD` metres: the closest point on it (qx, qy), the unit normal pointing
 * out of the building (nx, ny), the distance d, the building's height and the building object itself. Null when no wall is that close, or when the point is
 * inside a building.
 */
export function nearestWall(index, x, y, maxD) {
  let best = null;
  for (const it of index) {
    if (x < it.minx - maxD || x > it.maxx + maxD || y < it.miny - maxD || y > it.maxy + maxD) continue;
    if (inRing(x, y, it.ring)) return null;
    const ring = it.ring;
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const a = ring[k];
      const b = ring[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
      const qx = a[0] + dx * t;
      const qy = a[1] + dy * t;
      const d = Math.hypot(x - qx, y - qy);
      if (d > maxD || (best && d >= best.d)) continue;
      const L = Math.sqrt(L2);
      let nx = -dy / L;
      let ny = dx / L;
      // out of the building: the side where a step along the normal leaves the ring
      if (inRing(qx + nx * 0.05, qy + ny * 0.05, ring)) {
        nx = -nx;
        ny = -ny;
      }
      best = { qx, qy, nx, ny, d, height: it.height, building: it.building };
    }
  }
  return best;
}
