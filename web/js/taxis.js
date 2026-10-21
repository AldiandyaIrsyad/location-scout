// Taxis among the street traffic, behind the "Cars" section of the World settings panel. Pure data and decisions, no
// rendering (render.js recolours some cars and puts a roof light on them). The colours follow the place: yellow cabs in
// New York, black ones in London, a mix in Tokyo, pink and green in Bangkok.

export const TAXI_COLOURS = {
  yellow: '#f2c230',
  black: '#1d1e22',
  green: '#2f9a5c',
  white: '#f2f2f4',
  pink: '#e56fa0',
  blue: '#2f7fd0',
  orange: '#e8832f',
};
export const TAXI_CHOICES = ['auto', ...Object.keys(TAXI_COLOURS)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** The taxi colour names of a place and how common taxis are there (the share of cars at the 100% slider). */
export function taxiPlace(center) {
  if (inBox(center, 40, 41.2, -75, -73)) return { colours: ['yellow'], factor: 0.6 };
  if (inBox(center, 51, 52, -0.6, 0.4)) return { colours: ['black'], factor: 0.5 };
  if (inBox(center, 33, 39, 124, 132)) return { colours: ['white', 'white', 'orange'], factor: 0.3 }; // Korea first: its box lies inside the Japan box
  if (inBox(center, 24, 46, 122, 146)) return { colours: ['black', 'black', 'yellow', 'green'], factor: 0.3 };
  if (inBox(center, 13, 14.5, 100, 101)) return { colours: ['pink', 'pink', 'green', 'yellow'], factor: 0.5 };
  if (inBox(center, -7, -5.5, 106, 107.5)) return { colours: ['blue', 'blue', 'white'], factor: 0.3 };
  return { colours: ['white', 'black', 'yellow'], factor: 0.12 };
}

/** Chance that a car is a taxi: the slider is a percentage, scaled by how common taxis are in the place. */
export function taxiChance(share, center) {
  return Math.min(0.9, (Math.max(0, Math.min(100, Number(share) || 0)) / 100) * taxiPlace(center).factor);
}

/** Taxi colour: a chosen one, or from the place's own palette for 'auto' and unknown choices, by `u` (0..1). */
export function taxiColour(choice, center, u) {
  const fixed = own(TAXI_COLOURS, choice);
  if (fixed) return fixed;
  const set = taxiPlace(center).colours;
  return TAXI_COLOURS[set[Math.min(set.length - 1, Math.floor(Math.max(0, Number(u) || 0) * set.length))]];
}

/** Whether a car of a body type can be a taxi: ordinary cars only, not buses, pickups, vans or kei cars. */
export function canBeTaxi(type) {
  return type === 'sedan' || type === 'compact';
}

/**
 * The roof light in the car's own frame (x across, y up from the ground, z forward): one box { x0, x1, y0, y1, z0, z1 }
 * sitting on the roof, as wide as a hand-span of the roof and set slightly behind the middle.
 */
export function roofLight(roofHeight = 1.45) {
  return { x0: -0.24, x1: 0.24, y0: roofHeight, y1: roofHeight + 0.14, z0: -0.14, z1: 0.1 };
}
