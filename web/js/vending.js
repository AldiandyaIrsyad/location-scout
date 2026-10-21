// Drink vending machines on the pavement, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the boxes from vendingParts).

export const VENDING_COLOURS = {
  red: '#c8352f',
  blue: '#2f64b5',
  white: '#e9ebee',
  black: '#2c3036',
  green: '#2f8a5b',
  orange: '#e0802c',
};
export const VENDING_CHOICES = ['mixed', ...Object.keys(VENDING_COLOURS)];
export const DRINK_COLOURS = ['#e24a3b', '#3b82c4', '#f2c94c', '#46a35e', '#f08a3c', '#d9dde2', '#8a5aa8'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/**
 * Metres between machines along a street at 100% density: Japan has one every few shops, Korea and
 * Indonesia fewer, and elsewhere they are rare on the pavement.
 */
export function vendingSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 30; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 14;
  if (inBox(center, -11, 6, 95, 141)) return 45;
  return 90;
}

/** Chance that a street sample gets a machine (or group): density is a percentage, `every` the sampling interval in metres. */
export function vendingChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Body colour for a choice ('mixed' picks one per machine group from `u`, 0..1); unknown choices count as mixed. */
export function vendingColour(choice, u) {
  const fixed = own(VENDING_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(VENDING_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(u * all.length))];
}

/** Machines standing side by side in one spot: 1 (55%), 2 (30%) or 3 (15%). */
export function vendingGroupSize(u) {
  return u < 0.55 ? 1 : u < 0.85 ? 2 : 3;
}

export const VENDING_WIDTH = 0.8;

/**
 * One machine as boxes in its local frame: u runs the way it faces (towards the street), v across it, h is height.
 * Roles: body (the chosen colour), panel (the lit drink window), slot (the dark dispenser), drink (a row of cans,
 * `slot` is the can's index into DRINK_COLOURS), trim (the darker base and top).
 */
export function vendingParts(rand) {
  const part = (u0, u1, v0, v1, h0, h1, role, extra = {}) => ({ u0, u1, v0, v1, h0, h1, role, ...extra });
  const parts = [
    part(-0.32, 0.3, -0.4, 0.4, 0.1, 1.82, 'body'),
    part(-0.34, 0.32, -0.42, 0.42, 0, 0.1, 'trim'),
    part(-0.34, 0.32, -0.42, 0.42, 1.82, 1.9, 'trim'),
    part(0.3, 0.33, -0.32, 0.12, 0.62, 1.62, 'panel'), // the window of drinks
    part(0.3, 0.33, 0.17, 0.35, 1.0, 1.55, 'trim'), // coin and button panel
    part(0.3, 0.33, -0.3, 0.1, 0.2, 0.42, 'slot'), // dispenser flap
  ];
  // three rows of cans in the window
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      const v0 = -0.3 + col * 0.075;
      parts.push(part(0.33, 0.36, v0, v0 + 0.06, 0.7 + row * 0.3, 0.9 + row * 0.3, 'drink', { slot: Math.floor(rand() * DRINK_COLOURS.length) }));
    }
  }
  return parts;
}
