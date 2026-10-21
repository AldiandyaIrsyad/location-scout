// Parked scooters and motorbikes on the pavement, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the boxes and wheels from scooterParts).

export const SCOOTER_COLOURS = {
  black: '#25272b',
  white: '#e4e6e8',
  red: '#b3302b',
  blue: '#2c5f9e',
  silver: '#a7adb3',
  yellow: '#d8b130',
  green: '#3c7a57',
};
export const SCOOTER_CHOICES = ['mixed', ...Object.keys(SCOOTER_COLOURS)];
export const SCOOTER_STYLES = ['mixed', 'scooter', 'motorbike'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between scooter spots at 100%: Southeast Asia is full of them, then Taiwan, Japan and Korea, then Mediterranean Europe. */
export function scooterSpacing(center) {
  if (inBox(center, -11, 20, 95, 141)) return 9; // Indonesia, Thailand, Vietnam, the Philippines...
  if (inBox(center, 21, 26, 119, 123)) return 8; // Taiwan
  if (inBox(center, 33, 39, 124, 132)) return 40; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 28;
  if (inBox(center, 35, 46, -10, 20)) return 30;
  return 70;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function scooterChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Body colour for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function scooterColour(choice, u) {
  const fixed = own(SCOOTER_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(SCOOTER_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/** One lone scooter along the wall (45%), a tight row of two to four (35%), or a crowd of five to eight (20%). */
export function scooterGroup(u) {
  if (u < 0.45) return { count: 1, row: false };
  if (u < 0.8) return { count: 2 + Math.min(2, Math.floor(((u - 0.45) / 0.35) * 3)), row: true };
  return { count: 5 + Math.min(3, Math.floor(((u - 0.8) / 0.2) * 4)), row: true };
}

/** The design to draw: a chosen one, or 'scooter' (75%) / 'motorbike' (25%) from `u` for 'mixed' and anything unknown. */
export function scooterStyle(choice, u) {
  return choice === 'scooter' || choice === 'motorbike' ? choice : u < 0.75 ? 'scooter' : 'motorbike';
}

/**
 * One machine in its local frame: u along it (front at +u), v across, h up from the ground. `size` scales it (0.8..1.4).
 * Returns the two wheels ({ u, h, r }), the frame tubes ({ a: [u, h, v], b, role }) and the boxes
 * ({ u0, u1, v0, v1, h0, h1, role }). Roles: body (the chosen colour), seat, dark (engine, handlebars, forks),
 * metal (exhaust), light (headlamp) and tail.
 */
export function scooterParts(style, size = 1) {
  const k = Math.max(0.8, Math.min(1.4, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  const tube = (a, b, role = 'dark') => ({ a: a.map((x) => x * k), b: b.map((x) => x * k), role });
  if (style === 'motorbike') {
    const r = 0.3;
    return {
      wheels: [{ u: -0.62 * k, h: r * k, r: r * k }, { u: 0.62 * k, h: r * k, r: r * k }],
      tubes: [
        tube([0.62, r, 0.07], [0.44, 0.84, 0.07]), tube([0.62, r, -0.07], [0.44, 0.84, -0.07]), // forks
        tube([0.42, 0.9, -0.34], [0.42, 0.9, 0.34]), // handlebar
        tube([0.4, 0.92, 0.3], [0.34, 1.08, 0.38]), tube([0.4, 0.92, -0.3], [0.34, 1.08, -0.38]), // mirror stalks
        tube([-0.62, r, 0.07], [-0.3, 0.3, 0.07]), // swing arm
      ],
      boxes: [
        box(-0.05, 0.38, -0.15, 0.15, 0.6, 0.88, 'body'), // tank
        box(-0.6, 0.0, -0.13, 0.13, 0.68, 0.78, 'seat'),
        box(-0.12, 0.34, -0.1, 0.1, 0.26, 0.62, 'dark'), // engine
        box(-0.68, 0.0, 0.11, 0.17, 0.2, 0.3, 'metal'), // exhaust
        box(0.44, 0.52, -0.1, 0.1, 0.74, 0.9, 'light'),
        box(-0.72, -0.62, -0.1, 0.1, 0.62, 0.7, 'tail'),
        box(-0.72, -0.4, -0.08, 0.08, 0.68, 0.72, 'body'), // tail cowl
      ],
    };
  }
  const r = 0.2;
  return {
    wheels: [{ u: -0.55 * k, h: r * k, r: r * k }, { u: 0.55 * k, h: r * k, r: r * k }],
    tubes: [
      tube([0.55, r, 0.05], [0.42, 0.9, 0.05]), tube([0.55, r, -0.05], [0.42, 0.9, -0.05]), // forks
      tube([0.4, 0.95, -0.32], [0.4, 0.95, 0.32]), // handlebar
      tube([0.38, 0.97, 0.28], [0.3, 1.12, 0.36]), tube([0.38, 0.97, -0.28], [0.3, 1.12, -0.36]), // mirror stalks
    ],
    boxes: [
      box(-0.25, 0.36, -0.2, 0.2, 0.18, 0.26, 'body'), // the step-through floor
      box(-0.72, -0.2, -0.17, 0.17, 0.25, 0.62, 'body'), // rear body
      box(-0.62, -0.05, -0.15, 0.15, 0.62, 0.72, 'seat'),
      box(0.34, 0.5, -0.19, 0.19, 0.22, 0.88, 'body'), // leg shield and front
      box(0.34, 0.48, -0.15, 0.15, 0.86, 0.96, 'dark'), // handlebar cover
      box(0.49, 0.54, -0.09, 0.09, 0.7, 0.82, 'light'),
      box(-0.76, -0.71, -0.1, 0.1, 0.5, 0.58, 'tail'),
    ],
  };
}
