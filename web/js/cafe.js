// Cafe terraces on the pavement in front of walls: small round tables, chairs round them and sometimes a parasol, behind
// the "Street furniture" section of the World settings panel. Pure data and decisions, no rendering (render.js builds
// the pieces from terraceLayout, tableParts, chairParts and parasolParts).

export const CHAIR_COLOURS = { rattan: '#b58a52', black: '#2a2c30', green: '#3f6b4f', red: '#a8332e', white: '#e8e6df' };
export const CHAIR_CHOICES = ['auto', ...Object.keys(CHAIR_COLOURS)];
export const PARASOL_COLOURS = ['#c8483a', '#e8e0cc', '#2f6a5a', '#d6a63a', '#3a5c8a'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between terraces at 100%: Europe has the most, Japan and Korea the fewest. */
export function cafeSpacing(center) {
  if (inBox(center, 33, 39, 124, 132) || inBox(center, 24, 46, 122, 146)) return 90;
  if (inBox(center, 35, 60, -12, 30)) return 40;
  if (inBox(center, -11, 26, 95, 123)) return 55;
  return 100;
}

/** Chance that a street sample gets a terrace: density is a percentage, `every` the sampling interval in metres. */
export function cafeChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Chair colour: a chosen one, or by place for 'auto' and unknown choices (rattan and black in Europe, white/black/green in Asia, red/black elsewhere), by `u` (0..1). */
export function chairColour(choice, center, u) {
  const fixed = own(CHAIR_COLOURS, choice);
  if (fixed) return fixed;
  const set = inBox(center, 35, 60, -12, 30) ? ['rattan', 'rattan', 'black']
    : inBox(center, -11, 46, 95, 146) ? ['white', 'black', 'green']
      : ['red', 'black', 'black'];
  return CHAIR_COLOURS[set[Math.min(set.length - 1, Math.floor(Math.max(0, Number(u) || 0) * set.length))]];
}

/** Whether a table has a parasol: share is a percentage, `u` a 0..1 draw. */
export function hasParasol(share, u) {
  return (Number(u) || 0) < Math.max(0, Math.min(100, Number(share) || 0)) / 100;
}

/** Parasol canopy colour from `u` (0..1). */
export function parasolColour(u) {
  return PARASOL_COLOURS[Math.min(PARASOL_COLOURS.length - 1, Math.floor(Math.max(0, Number(u) || 0) * PARASOL_COLOURS.length))];
}

/**
 * The layout of one terrace in a frame with u along the wall and v out from it: `tables` ({ u, v, chairs }) in a row
 * along the wall, one to four of them 1.7 m apart, each with two or three `chairs` ({ u, v, face }) round it, `face` the
 * direction (radians from +u) the chair looks, towards its table. `rand` is a 0..1 source; `size` (0.7..1.5) scales the
 * spacing.
 */
export function terraceLayout(rand, size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const n = 1 + Math.min(3, Math.floor(rand() * 4));
  const tables = [];
  for (let i = 0; i < n; i++) {
    const t = { u: (i - (n - 1) / 2) * 1.7 * k, v: 0, chairs: [] };
    const nc = 2 + (rand() < 0.45 ? 1 : 0);
    const start = rand() * Math.PI * 2;
    for (let j = 0; j < nc; j++) {
      const a = start + (j / nc) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const r = 0.58 * k;
      t.chairs.push({ u: t.u + Math.cos(a) * r, v: Math.sin(a) * r, face: a + Math.PI });
    }
    tables.push(t);
  }
  return { tables };
}

/** A table in its own frame centred on the origin (u, v across, h up): a top, a stem and a foot; `size` scales it. */
export function tableParts(size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  return [
    box(-0.3, 0.3, -0.3, 0.3, 0.72, 0.76, 'top'),
    box(-0.035, 0.035, -0.035, 0.035, 0.03, 0.72, 'stem'),
    box(-0.2, 0.2, -0.2, 0.2, 0, 0.03, 'stem'),
  ];
}

/** A chair in its own frame looking along +v (u across, v forward, h up): seat, back and four legs; `size` scales it. */
export function chairParts(size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => box(a * 0.19 - 0.015, a * 0.19 + 0.015, b * 0.19 - 0.015, b * 0.19 + 0.015, 0, 0.42, 'leg'));
  return [
    box(-0.21, 0.21, -0.21, 0.21, 0.42, 0.46, 'seat'),
    box(-0.21, 0.21, -0.22, -0.18, 0.46, 0.88, 'back'),
    ...legs,
  ];
}

/** A parasol in its own frame centred on the origin: a pole and a shallow cone canopy (radius, rim height, apex height). */
export function parasolParts(size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  return { pole: { r: 0.025 * k, h0: 0, h1: 2.35 * k }, canopy: { r: 1.15 * k, h0: 2.05 * k, h1: 2.4 * k } };
}
