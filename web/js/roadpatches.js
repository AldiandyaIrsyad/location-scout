// Repair patches and cracks in the road surface, behind the "Ground" section of the World settings panel. They are
// real (millimetre-thin) geometry so the line pass draws an ink outline round them, which survives the cel pass
// where a shader texture does not. Pure data and decisions, no rendering.

/** Metres of road between patches / cracks at 100%. */
export const PATCH_SPACING = 16;
export const CRACK_SPACING = 10;

/** Chance that a street sample gets one: density is a percentage, `every` the sampling interval in metres. */
export function patchChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/**
 * An irregular four-sided patch of about w x d metres in its own plane (x across, y along): the corners of a
 * rectangle moved by up to 12% of its size. `rand` is a 0..1 stream. Returns four [x, y] corners in order.
 */
export function patchPolygon(rand, w, d) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [
    sx * (w / 2) * (1 + (rand() - 0.5) * 0.24),
    sy * (d / 2) * (1 + (rand() - 0.5) * 0.24),
  ]);
}

/**
 * A crack of about `len` metres along y from the origin: a zigzag that wanders sideways by up to `wander` metres
 * per step, with the steps `step` metres long. At least two points. Returns [x, y] points.
 */
export function crackPoints(rand, len, wander = 0.14, step = 0.4) {
  const n = Math.max(1, Math.round(len / step));
  const pts = [[0, 0]];
  let x = 0;
  for (let i = 1; i <= n; i++) {
    x += (rand() - 0.5) * 2 * wander;
    x = Math.max(-0.5, Math.min(0.5, x));
    pts.push([x, (i * len) / n]);
  }
  return pts;
}

/** Patch size from `u`, `v` (0..1) and the "size" multiplier: 0.9 to 2.8 m wide, 1.2 to 3.6 m long, times the size. */
export function patchSize(u, v, size = 1) {
  const k = Math.max(0.5, Math.min(2, Number(size) || 1));
  return { w: (0.9 + 1.9 * Math.max(0, Math.min(1, u))) * k, d: (1.2 + 2.4 * Math.max(0, Math.min(1, v))) * k };
}

/** Patch brightness against the road: new asphalt is darker (u < 0.65), an old repair paler. */
export function patchShade(u) {
  return u < 0.65 ? 0.8 : 1.14;
}

/** Metres of road between puddles at full wetness (100%). */
export const PUDDLE_SPACING = 9;

/**
 * Chance that a street sample gets a puddle: `wet` is the "Wet streets" percentage. Nothing below 15% (damp, but no
 * standing water yet), rising to the full rate at 100%.
 */
export function puddleChance(wet, every) {
  const w = Math.max(0, Math.min(100, Number(wet) || 0));
  if (w < 15) return 0;
  return Math.min(1, (((w - 15) / 85) * every) / PUDDLE_SPACING);
}

/**
 * A rounded puddle outline of about w x d metres in its own plane: ten points round an ellipse, each radius moved by
 * up to 22%. `rand` is a 0..1 stream. Returns [x, y] points in order.
 */
export function puddlePolygon(rand, w, d) {
  const n = 10;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1 + (rand() - 0.5) * 0.44;
    out.push([Math.cos(a) * (w / 2) * r, Math.sin(a) * (d / 2) * r]);
  }
  return out;
}

/** Puddle size from `u`, `v` (0..1) and the size multiplier (clamped 0.5..2): 0.8 to 2.4 m wide and 0.6 to 1.6 m long, times the size. */
export function puddleSize(u, v, size = 1) {
  const k = Math.max(0.5, Math.min(2, Number(size) || 1));
  return { w: (0.8 + 1.6 * Math.max(0, Math.min(1, u))) * k, d: (0.6 + 1.0 * Math.max(0, Math.min(1, v))) * k };
}

/** How much darker the wet asphalt and paving are: 0 dry, up to 30% darker at full wetness. */
export function wetDarkening(wet) {
  return 0.3 * Math.max(0, Math.min(100, Number(wet) || 0)) / 100;
}
