// Wall trim on buildings: a plinth at the foot, a thin string course between floors and a cornice under the roof,
// behind the "Buildings" section of the World settings panel. Pure data and decisions, no rendering (render.js builds
// the bands as thin boxes round the footprint, from trimBands).

export const TRIM_TONES = { light: 1.12, same: 1.0, dark: 0.78 };
export const TRIM_CHOICES = Object.keys(TRIM_TONES);

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Whether a building gets trim: share is a percentage, `u` a 0..1 draw unique to the building. */
export function hasTrim(share, u) {
  const s = Math.max(0, Math.min(100, Number(share) || 0)) / 100;
  return (Number(u) || 0) < s;
}

/** Brightness multiplier for the trim against the wall: unknown choices count as 'light'. */
export function trimTone(choice) {
  return own(TRIM_TONES, choice) ?? TRIM_TONES.light;
}

/** How far the bands stand out from the wall, in metres: the depth control clamped to 0.02..0.25. */
export function trimDepth(depth) {
  const d = Number(depth);
  return Math.max(0.02, Math.min(0.25, Number.isFinite(d) ? d : 0.07));
}

/**
 * The bands on a wall running from absolute height `bottom` to `wallTop` over ground `ground`: { h0, h1, out, role }
 * with heights in absolute metres and `out` the projection from the wall. The plinth sits on the ground, string courses
 * sit in the gap between window rows (rows span 0.8 to 2.5 m above a multiple of 3.2, so mid-gap is 3.25 above it) and
 * the cornice is two stepped bands under the roof edge. Walls under two storeys get no string courses, under
 * 3.5 m no cornice.
 */
export function trimBands(bottom, wallTop, depth = 0.07, ground = bottom) {
  const d = trimDepth(depth);
  const bands = [];
  const height = wallTop - ground;
  if (height < 2.2) return bands;
  bands.push({ h0: bottom, h1: ground + 0.55, out: d * 1.3, role: 'plinth' });
  if (height >= 3.5) {
    bands.push({ h0: wallTop - 0.32, h1: wallTop - 0.1, out: d * 1.6, role: 'cornice' });
    bands.push({ h0: wallTop - 0.1, h1: wallTop, out: d * 2.6, role: 'cornice' });
  }
  const top = height >= 3.5 ? wallTop - 0.6 : wallTop;
  for (let m = Math.ceil((ground + 2.2 - 3.25) / 3.2); m * 3.2 + 3.25 + 0.07 <= top; m++) {
    const mid = m * 3.2 + 3.25;
    bands.push({ h0: mid - 0.07, h1: mid + 0.07, out: d, role: 'floor' });
  }
  return bands;
}

/**
 * Quads ([x, y] corners) for a band `out` metres wide just outside each edge of a footprint, whichever way the ring runs.
 * Each strip is lengthened by `out` at both ends so neighbouring strips meet at a convex corner instead of leaving a notch.
 * Edges shorter than 0.3 m are skipped.
 */
export function outwardStrips(ring, out) {
  let area = 0;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) area += ring[k][0] * ring[i][1] - ring[i][0] * ring[k][1];
  const ccw = area > 0;
  const quads = [];
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[k];
    const b = ring[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 0.3) continue;
    const ex = (dx / L) * out;
    const ey = (dy / L) * out;
    // outward normal: right of the edge for a counter-clockwise ring, left for a clockwise one
    const nx = ((ccw ? dy : -dy) / L) * out;
    const ny = ((ccw ? -dx : dx) / L) * out;
    quads.push([[a[0] - ex, a[1] - ey], [b[0] + ex, b[1] + ey], [b[0] + ex + nx, b[1] + ey + ny], [a[0] - ex + nx, a[1] - ey + ny]]);
  }
  return quads;
}
