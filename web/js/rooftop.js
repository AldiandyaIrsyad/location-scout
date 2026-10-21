// Clutter on flat roofs (air-conditioner units, water tanks, stairwell boxes, antenna masts) and the parapet round
// the edge, behind the "Buildings" section of the World settings panel. Pure geometry and decisions, no rendering
// (render.js builds the boxes). Positions are in local metres, like the building rings.

export const TANK_COLOURS = { green: '#4f7a5c', blue: '#4a76a8', grey: '#9a9da3', rust: '#9a5a3c' };
export const TANK_CHOICES = ['auto', ...Object.keys(TANK_COLOURS)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Tank colour for a choice; 'auto' and unknown choices pick by `u` (0..1). */
export function tankColour(choice, u) {
  const fixed = own(TANK_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(TANK_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/**
 * What goes on a flat roof of `area` square metres and `height` metres: a count of air-conditioner units and
 * whether there is a water tank, a stairwell box and an antenna mast. `amount` is the percentage slider; `rand`
 * a 0..1 stream. Small or low roofs get nothing, because a shed or a porch has no plant on it.
 */
export function rooftopPlan(rand, { area, height, amount }) {
  const k = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  const none = { ac: 0, tank: false, stair: false, mast: false };
  if (k === 0 || !(area >= 40) || !(height >= 7)) return none;
  const ac = Math.min(10, Math.round((k * area) / 70 + rand() * k * 2));
  const tank = area >= 120 && height >= 10 && rand() < 0.55 * k;
  const stair = area >= 90 && height >= 9 && rand() < 0.6 * k;
  const mast = rand() < 0.4 * k;
  return { ac, tank, stair, mast };
}

/** Footprint (w across, d deep) and height h of an item; `rand` is a 0..1 stream. */
export function itemSize(kind, rand) {
  switch (kind) {
    case 'ac': return { w: 0.8 + 0.5 * rand(), d: 0.5 + 0.2 * rand(), h: 0.7 + 0.5 * rand() };
    case 'tank': { const r = 0.9 + 0.5 * rand(); return { w: r * 2, d: r * 2, h: 1.9 + 0.8 * rand() }; }
    case 'stair': return { w: 2.4 + 1.4 * rand(), d: 2.6 + 1.2 * rand(), h: 2.4 };
    case 'mast': return { w: 0.5, d: 0.5, h: 3 + 3 * rand() };
    default: return { w: 1, d: 1, h: 1 };
  }
}

/** Unit vector along the longest edge of a ring, so roof items line up with the building. */
export function roofAxis(ring) {
  let best = 0;
  let ux = 1;
  let uy = 0;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const dx = ring[i][0] - ring[k][0];
    const dy = ring[i][1] - ring[k][1];
    const L = Math.hypot(dx, dy);
    if (L > best) {
      best = L;
      ux = dx / L;
      uy = dy / L;
    }
  }
  return { ux, uy };
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

/** Distance from (x, y) to the nearest edge of the ring. */
function edgeDistance(x, y, ring) {
  let best = Infinity;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[k];
    const b = ring[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)));
  }
  return best;
}

/**
 * Find a spot for a box of w x d (aligned to the roof axis) on the roof: all four corners inside the ring and at
 * least `margin` from its edge, not overlapping the boxes already `placed` (kept as { x, y, r } circles; this
 * function pushes the new one). Returns { x, y } (the centre) or null after `tries` attempts.
 */
export function placeOnRoof(ring, rand, w, d, placed, { margin = 0.9, tries = 24 } = {}) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const { ux, uy } = roofAxis(ring);
  const r = Math.hypot(w, d) / 2;
  for (let n = 0; n < tries; n++) {
    const x = minx + rand() * (maxx - minx);
    const y = miny + rand() * (maxy - miny);
    let ok = true;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = x + ux * su * (w / 2) - uy * sv * (d / 2);
      const cy = y + uy * su * (w / 2) + ux * sv * (d / 2);
      if (!inRing(cx, cy, ring) || edgeDistance(cx, cy, ring) < margin) { ok = false; break; }
    }
    if (!ok) continue;
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + 0.4)) continue;
    placed.push({ x, y, r });
    return { x, y };
  }
  return null;
}

/**
 * The parapet round a roof edge as quads ([x, y] corners in order): a strip `thickness` metres wide just inside each
 * edge. Edges shorter than 0.3 m are skipped.
 */
export function parapetStrips(ring, thickness) {
  let area = 0;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) area += ring[k][0] * ring[i][1] - ring[i][0] * ring[k][1];
  const ccw = area > 0;
  const out = [];
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[k];
    const b = ring[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 0.3) continue;
    // inward normal: left of the edge for a counter-clockwise ring, right for a clockwise one
    const nx = ((ccw ? -dy : dy) / L) * thickness;
    const ny = ((ccw ? dx : -dx) / L) * thickness;
    out.push([[a[0], a[1]], [b[0], b[1]], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]);
  }
  return out;
}
