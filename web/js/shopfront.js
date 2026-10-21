// Shop awnings and projecting signs on street-facing walls, behind the "Street furniture" section of the World
// settings panel. Pure data and decisions, no rendering (render.js builds the quads from awningParts / signParts).

export const AWNING_COLOURS = {
  red: '#b8342f',
  green: '#2f7a52',
  navy: '#2b4272',
  cream: '#e4d9bd',
  orange: '#d9792b',
  teal: '#2a8a8c',
};
export const AWNING_CHOICES = ['mixed', ...Object.keys(AWNING_COLOURS)];
export const SIGN_COLOURS = ['#f2efe3', '#e8c13a', '#c8352f', '#2f64b5', '#2c3036', '#f08a3c', '#46a35e'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/**
 * Metres of street between shop awnings at 100% density. Paris and other old European streets are lined with
 * them; Japan and Korea have fewer awnings but more signs (see signSpacing); the default is a middle value.
 */
export function awningSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 22; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 20;
  if (inBox(center, -11, 6, 95, 141)) return 26;
  if (inBox(center, 35, 60, -12, 30)) return 14; // Europe
  return 30;
}

/** Metres of street between projecting signs at 100%: Japanese and Korean streets bristle with them. */
export function signSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 9;
  if (inBox(center, 24, 46, 122, 146)) return 8;
  if (inBox(center, -11, 6, 95, 141)) return 20;
  if (inBox(center, 35, 60, -12, 30)) return 30;
  return 24;
}

/** Chance that a street sample gets one: density is a percentage, `every` the sampling interval in metres. */
export function shopChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Awning colour for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function awningColour(choice, u) {
  const fixed = own(AWNING_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(AWNING_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(u * all.length))];
}

/** Sign board colour from `u`, 0..1. */
export function signColour(u) {
  return SIGN_COLOURS[Math.min(SIGN_COLOURS.length - 1, Math.floor(Math.max(0, u) * SIGN_COLOURS.length))];
}

/**
 * Width of an awning in metres: from `u` (0..1) between 2 and 4.5, but never wider than the wall run `room`
 * (the free wall on both sides of the spot, in metres) allows, and null when even the narrowest does not fit.
 */
export function awningWidth(u, room) {
  const w = Math.min(2 + 2.5 * Math.max(0, Math.min(1, u)), room - 0.3);
  return w >= 1.6 ? w : null;
}

/**
 * An awning as quads in its local frame: u across the wall (centred), v out from the wall, h up.
 * The cloth slopes down from `top` at the wall to `top - drop` at `depth` out, in `stripes` alternating bands
 * (role 'cloth' / 'alt'); a vertical valance hangs from the front edge; the underside is darker ('under').
 * Each quad is four [u, v, h] corners in order.
 */
export function awningParts({ width, depth, top, drop = 0.55, valance = 0.22, stripes = 6 }) {
  const n = Math.max(1, Math.floor(stripes));
  const out = [];
  const edge = top - drop;
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    const u0 = -half + (width * i) / n;
    const u1 = -half + (width * (i + 1)) / n;
    const role = i % 2 ? 'alt' : 'cloth';
    out.push({ role, quad: [[u0, 0, top], [u1, 0, top], [u1, depth, edge], [u0, depth, edge]] });
    out.push({ role: 'under', quad: [[u0, 0, top - 0.02], [u1, 0, top - 0.02], [u1, depth, edge - 0.02], [u0, depth, edge - 0.02]] });
    out.push({ role, quad: [[u0, depth, edge], [u1, depth, edge], [u1, depth, edge - valance], [u0, depth, edge - valance]] });
  }
  return out;
}

/**
 * A projecting blade sign as quads in the same frame: a bracket arm out from the wall and a board standing
 * across the arm's end (its faces point along the wall so passers-by see it from either direction).
 */
export function signParts({ width, height, out, top }) {
  const half = width / 2;
  const b0 = top - 0.08; // top of the board
  const parts = [
    { role: 'arm', quad: [[-0.03, 0, top - 0.04], [0.03, 0, top - 0.04], [0.03, out, top - 0.04], [-0.03, out, top - 0.04]] },
    { role: 'board', quad: [[0, out - half, b0], [0, out + half, b0], [0, out + half, b0 - height], [0, out - half, b0 - height]] },
    { role: 'frame', quad: [[-0.05, out - half, b0], [0.05, out - half, b0], [0.05, out + half, b0], [-0.05, out + half, b0]] },
  ];
  // dark bars across the board stand in for lettering (kept clear of the edges), on both faces
  const lines = Math.max(1, Math.floor(height / 0.32));
  for (let i = 0; i < lines; i++) {
    const hc = b0 - ((i + 0.5) * height) / lines;
    const hh = Math.min(0.07, height / lines / 3);
    const w = half * (i % 2 ? 0.5 : 0.7);
    for (const u of [0.012, -0.012]) {
      parts.push({ role: 'text', quad: [[u, out - w, hc + hh], [u, out + w, hc + hh], [u, out + w, hc - hh], [u, out - w, hc - hh]] });
    }
  }
  return parts;
}
