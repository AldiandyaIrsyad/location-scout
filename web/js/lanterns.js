// Paper lanterns and door curtains (noren) at shop doors, behind the "Street furniture" section of the World settings
// panel. Pure data and decisions, no rendering (render.js builds the blobs and boxes).

export const LANTERN_TONES = { red: '#c8301f', white: '#f1ece0', mixed: '' };
export const LANTERN_CHOICES = ['mixed', 'red', 'white'];
export const NOREN_COLOURS = ['#2c3e6e', '#8c2f2a', '#2a5a48', '#4a4a52'];

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/**
 * Metres of street between lantern spots at 100%: shopping alleys in Japan are strung with them, Korea has some,
 * elsewhere only the odd restaurant has one.
 */
export function lanternSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 30; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 14;
  if (inBox(center, -11, 6, 95, 141)) return 50;
  return 90;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function lanternChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Lantern colour for a choice ('mixed' is red 70% and white 30% by `u`, 0..1); unknown choices count as mixed. */
export function lanternColour(choice, u) {
  if (choice === 'red' || choice === 'white') return LANTERN_TONES[choice];
  return u < 0.7 ? LANTERN_TONES.red : LANTERN_TONES.white;
}

/** How many lanterns hang in a row at one door: 1 to 3, from `u` (0..1). */
export function lanternCount(u) {
  return u < 0.5 ? 1 : u < 0.85 ? 2 : 3;
}

/**
 * One lantern in its own frame: u across the wall, v out from it, h up from the ground. A rounded body (`blob`: centre
 * and radius, squashed vertically by `sy`), a dark cap and base, a bracket arm, and a label panel on the front.
 * `size` scales it (0.6..1.6).
 */
export function lanternParts(size = 1) {
  const k = Math.max(0.6, Math.min(1.6, Number(size) || 1));
  const cy = 2.35 * 1;
  return {
    blob: { v: 0.42 * k, h: cy, r: 0.19 * k, sy: 1.45 },
    boxes: [
      { u0: -0.07 * k, u1: 0.07 * k, v0: 0.42 * k - 0.07 * k, v1: 0.42 * k + 0.07 * k, h0: cy + 0.19 * k * 1.45, h1: cy + 0.19 * k * 1.45 + 0.04, role: 'dark' },
      { u0: -0.07 * k, u1: 0.07 * k, v0: 0.42 * k - 0.07 * k, v1: 0.42 * k + 0.07 * k, h0: cy - 0.19 * k * 1.45 - 0.04, h1: cy - 0.19 * k * 1.45, role: 'dark' },
      { u0: -0.02, u1: 0.02, v0: 0, v1: 0.42 * k, h0: cy + 0.19 * k * 1.45 + 0.04, h1: cy + 0.19 * k * 1.45 + 0.07, role: 'arm' },
      { u0: -0.07 * k, u1: 0.07 * k, v0: 0.42 * k + 0.17 * k, v1: 0.42 * k + 0.2 * k, h0: cy - 0.18 * k, h1: cy + 0.18 * k, role: 'label' },
    ],
  };
}

/**
 * A door curtain: `strips` (3 or 4) cloth panels side by side with a slit between them, hanging from a rod at `top`
 * metres, `drop` long, over a doorway `width` metres wide, with a pale band across each panel's middle. Returns boxes
 * { u0, u1, v0, v1, h0, h1, role: 'cloth' | 'band' | 'rod' } in the wall frame.
 */
export function norenParts(width, top = 2.15, drop = 0.7, strips = 3) {
  const n = Math.max(2, Math.min(5, Math.floor(strips) || 3));
  const half = width / 2;
  const slit = 0.04;
  const w = (width - slit * (n - 1)) / n;
  const boxes = [{ u0: -half - 0.05, u1: half + 0.05, v0: 0.06, v1: 0.1, h0: top, h1: top + 0.03, role: 'rod' }];
  for (let i = 0; i < n; i++) {
    const u0 = -half + i * (w + slit);
    boxes.push({ u0, u1: u0 + w, v0: 0.07, v1: 0.09, h0: top - drop, h1: top, role: 'cloth' });
    boxes.push({ u0: u0 + w * 0.2, u1: u0 + w * 0.8, v0: 0.09, v1: 0.1, h0: top - drop * 0.62, h1: top - drop * 0.38, role: 'band' });
  }
  return boxes;
}
