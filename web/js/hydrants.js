// Fire hydrants on the pavement, behind the "Street furniture" section of the World settings panel. Pure data and
// decisions, no rendering (render.js builds the pieces from hydrantParts). Only some places have them above ground: the
// squat painted hydrant of North America stands at every few dozen metres, elsewhere they are mostly underground.

export const HYDRANT_COLOURS = { red: '#c0302a', yellow: '#e4b82a', blue: '#2f64b5', silver: '#aeb4ba' };
export const HYDRANT_CHOICES = ['auto', ...Object.keys(HYDRANT_COLOURS)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between hydrants at 100%: frequent in North America, rare elsewhere. */
export function hydrantSpacing(center) {
  if (inBox(center, 15, 72, -170, -50)) return 45;
  if (inBox(center, 24, 46, 122, 146)) return 260;
  return 140;
}

/** Chance that a street sample gets a hydrant: density is a percentage, `every` the sampling interval in metres. */
export function hydrantChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Paint colour: a chosen one, or by place for 'auto' and unknown choices (red in North America and Japan, yellow elsewhere). */
export function hydrantColour(choice, center) {
  const fixed = own(HYDRANT_COLOURS, choice);
  if (fixed) return fixed;
  return inBox(center, 15, 72, -170, -50) || inBox(center, 24, 46, 122, 146) ? HYDRANT_COLOURS.red : HYDRANT_COLOURS.yellow;
}

/**
 * One hydrant in its own frame (u across, v towards the street, h up from the ground): a round body `cyl` stack and
 * `boxes` ({ u0, u1, v0, v1, h0, h1, role }, roles paint and cap) for the nozzles and nut. `cyls` lists
 * { r, h0, h1, role } from the foot up. `size` scales everything (0.7..1.5).
 */
export function hydrantParts(size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  return {
    cyls: [
      { r: 0.14 * k, h0: 0, h1: 0.1 * k, role: 'paint' },
      { r: 0.1 * k, h0: 0.1 * k, h1: 0.56 * k, role: 'paint' },
      { r: 0.125 * k, h0: 0.56 * k, h1: 0.62 * k, role: 'cap' },
      { r: 0.075 * k, h0: 0.62 * k, h1: 0.7 * k, role: 'paint' },
    ],
    boxes: [
      box(-0.2, -0.08, -0.05, 0.05, 0.32, 0.42, 'cap'), // side nozzles
      box(0.08, 0.2, -0.05, 0.05, 0.32, 0.42, 'cap'),
      box(-0.07, 0.07, 0.08, 0.17, 0.26, 0.38, 'cap'), // the big pumper nozzle, towards the street
      box(-0.04, 0.04, -0.04, 0.04, 0.7, 0.74, 'cap'), // operating nut
    ],
  };
}
