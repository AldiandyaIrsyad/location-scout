// Street-name plates on building corners and walls, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the boxes from plateParts). They hang in the band between the
// ground-floor and first-floor windows (2.6 to 2.9 m), so they never collide with the window grid.

export const PLATE_COLOURS = { blue: '#1f4f9a', green: '#2b6b45', white: '#e9e8e0', black: '#26282c' };
export const PLATE_CHOICES = ['auto', ...Object.keys(PLATE_COLOURS)];

const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between plates at 100%: dense in Paris and Japan where every block is signed, sparser elsewhere. */
export function plateSpacing(center) {
  if (inBox(center, 41, 51.1, -5.5, 9.8)) return 45;
  if (inBox(center, 24, 46, 122, 146)) return 55;
  return 90;
}

/** Chance that a street sample gets a plate: density is a percentage, `every` the sampling interval in metres. */
export function plateChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Plate colour: a chosen one, or by place for 'auto' and unknown choices (blue in France and Japan, green in the Americas, white elsewhere). */
export function plateColour(choice, center) {
  const fixed = own(PLATE_COLOURS, choice);
  if (fixed) return fixed;
  if (inBox(center, 41, 51.1, -5.5, 9.8) || inBox(center, 24, 46, 122, 146)) return PLATE_COLOURS.blue;
  if (inBox(center, -56, 72, -170, -34)) return PLATE_COLOURS.green;
  return PLATE_COLOURS.white;
}

/** Whether lettering and border are light on the plate (dark plates) or dark (pale plates). */
export function plateInk(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#1b1c1f';
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l < 0.5 ? '#f3f1e6' : '#1b1c1f';
}

/** Size clamped to 0.7..3 (the plate is only 0.6 m wide at 1, so the range is generous). */
export function plateSize(size) {
  return Math.max(0.7, Math.min(3, Number(size) || 1));
}

/**
 * World height of the plate's centre on a wall whose ground is `ground` and whose building is `height` tall, or null if
 * it does not fit: the middle of the first gap above head height between two window rows (a row's windows span 0.8 to 2.5 m
 * above a multiple of 3.2, so the gap runs from 2.5 to 4.0 m above it).
 */
export function plateCentre(ground, height) {
  const m = Math.ceil((ground + 1.9 - 2.5) / 3.2);
  const centre = m * 3.2 + 3.25;
  return centre + 0.4 <= ground + height ? centre : null;
}

/**
 * One plate in its own frame: u along the wall, v out from the wall, h up from the plate's centre. Returns boxes
 * ({ u0, u1, v0, v1, h0, h1, role }, roles border, plate and text): a border slab, the coloured plate on it and two
 * lines of lettering as light bars.
 */
export function plateParts(size = 1) {
  const k = plateSize(size);
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  return [
    box(-0.32, 0.32, 0, 0.02, -0.13, 0.13, 'border'),
    box(-0.3, 0.3, 0.02, 0.035, -0.11, 0.11, 'plate'),
    box(-0.24, 0.24, 0.035, 0.045, 0.02, 0.06, 'text'),
    box(-0.18, 0.18, 0.035, 0.045, -0.06, -0.02, 'text'),
  ];
}
