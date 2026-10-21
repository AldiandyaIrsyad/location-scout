// Parked bicycles on the pavement, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the tubes from bicycleParts).

export const BIKE_COLOURS = {
  black: '#2b2d31',
  silver: '#aeb4ba',
  blue: '#2f64b5',
  red: '#b8342f',
  green: '#2f7a52',
  white: '#e6e8ea',
  pink: '#d96a8c',
};
export const BIKE_CHOICES = ['mixed', ...Object.keys(BIKE_COLOURS)];
export const BIKE_STYLES = ['mixed', 'city', 'road'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between bicycle spots at 100%: Japan most (shop-front mamachari), then Europe, Korea, Indonesia. */
export function bikeSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 45; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 16;
  if (inBox(center, -11, 6, 95, 141)) return 70;
  if (inBox(center, 35, 60, -12, 30)) return 26;
  return 50;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function bikeChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Frame colour for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function bikeColour(choice, u) {
  const fixed = own(BIKE_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(BIKE_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/** One bike leaning alone along the wall (50%), a short row of two or three (30%), or a rack of four or five (20%). */
export function bikeGroup(u) {
  if (u < 0.5) return { count: 1, row: false };
  if (u < 0.8) return { count: 2 + Math.floor(((u - 0.5) / 0.3) * 2), row: true };
  return { count: 4 + Math.floor(((u - 0.8) / 0.2) * 2), row: true };
}

/** The style to draw: a chosen one, or 'city' (70%) / 'road' (30%) from `u` for 'mixed' and anything unknown. */
export function bikeStyle(choice, u) {
  return choice === 'city' || choice === 'road' ? choice : u < 0.7 ? 'city' : 'road';
}

export const WHEEL_RADIUS = 0.34;

/**
 * One bicycle in its local frame: u along it (front at +u), h up, v across. Returns the two wheels
 * ({ u, h, r }), the frame tubes ({ a: [u, h, v], b, role }) and the boxes ({ u0, u1, v0, v1, h0, h1, role }).
 * Roles: frame (the chosen colour), dark (handlebars, chain, tyres' hubs), seat, basket (city bikes only).
 */
export function bicycleParts(style) {
  const r = WHEEL_RADIUS;
  const rear = [-0.52, r, 0];
  const front = [0.52, r, 0];
  const bb = [-0.08, 0.3, 0];
  const seat = [-0.24, 0.92, 0];
  const head = [0.4, 0.86, 0];
  const bars = style === 'road' ? [0.34, 0.96, 0] : [0.3, 1.04, 0];
  const tube = (a, b, role = 'frame') => ({ a, b, role });
  const tubes = [
    tube(rear, bb), tube(bb, seat), tube(seat, rear), tube(bb, head), tube(seat, head), // the diamond
    tube(head, front, 'dark'), tube(head, bars, 'dark'), // fork and stem
    tube([bars[0], bars[1], -0.28], [bars[0], bars[1], 0.28], 'dark'), // handlebar
    tube(bb, [-0.08, 0.3, 0.12], 'dark'), tube([-0.12, 0.22, 0.12], [-0.04, 0.38, 0.12], 'dark'), // pedal and crank
  ];
  const boxes = [{ u0: -0.34, u1: -0.12, v0: -0.07, v1: 0.07, h0: 0.92, h1: 0.97, role: 'seat' }];
  if (style !== 'road') {
    boxes.push({ u0: 0.52, u1: 0.8, v0: -0.19, v1: 0.19, h0: 0.82, h1: 1.0, role: 'basket' }); // front basket
    boxes.push({ u0: -0.7, u1: -0.38, v0: -0.08, v1: 0.08, h0: 0.62, h1: 0.66, role: 'dark' }); // rear rack
    tubes.push(tube([-0.52, 0.63, 0.1], [-0.52, 0.34, 0.07], 'dark'), tube([-0.52, 0.63, -0.1], [-0.52, 0.34, -0.07], 'dark')); // rack stays
  }
  return { wheels: [{ u: rear[0], h: r, r }, { u: front[0], h: r, r }], tubes, boxes };
}
