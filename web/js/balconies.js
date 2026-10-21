// Balconies with railings and hanging laundry on street-facing walls, behind the "Buildings" section of the World
// settings panel. Pure data and decisions, no rendering (render.js builds the boxes from balconyParts / laundryItems).
// Rows and columns follow the window grid of the building shader: floors every 3.2 m (a window from 0.8 to 2.5 m above
// each multiple of 3.2 in world height) and columns every 3 m (a window from 0.7 to 2.3 m of each).

export const BALCONY_STYLES = ['auto', 'solid', 'rail'];
export const LAUNDRY_COLOURS = ['#f2f0ea', '#8fb6d9', '#e8a6b5', '#f0d36a', '#7fae8b', '#c9c4e6', '#d98a6a'];
export const BALCONY_COLOURS = { solid: '#c9c4b9', rail: '#4a4e55', slab: '#b5b0a6', pole: '#8c9096', futon: '#e9d9b8' };

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** The balcony design: a chosen one, or by place for 'auto' and anything unknown (solid parapets in Japan and Korea). */
export function balconyStyleFor(choice, center) {
  if (choice === 'solid' || choice === 'rail') return choice;
  return inBox(center, 24, 46, 122, 146) ? 'solid' : 'rail';
}

/** Metres of street between balcony stacks at 100%: Japanese apartment blocks have the most, then Korea and Europe. */
export function balconySpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 16; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 11;
  if (inBox(center, 35, 60, -12, 30)) return 20;
  if (inBox(center, -11, 6, 95, 141)) return 30;
  return 34;
}

/** Chance that a street sample gets a stack: density is a percentage, `every` the sampling interval in metres. */
export function balconyChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** The window column centre nearest below `u`, along the wall (columns are 3 m wide, the window is centred in each). */
export function columnCentre(u) {
  return Math.floor(u / 3) * 3 + 1.5;
}

/**
 * Slab heights (world, metres) of a stack on a wall whose ground is `ground` and whose building is `height` tall:
 * on rows above the ground floor that still fit under the roof, each kept with chance `share` (0..1) from the
 * stream `rand`. A row sits at 0.8 m above a multiple of 3.2, the window sill height.
 */
export function slabHeights(ground, height, rand, share = 0.8) {
  const out = [];
  const first = Math.ceil((ground + 2.4 - 0.8) / 3.2);
  for (let m = first; m * 3.2 + 0.8 + 2.2 <= ground + height; m++) if (rand() < share) out.push(m * 3.2 + 0.8);
  return out;
}

/**
 * One balcony in its own frame: u across the wall (centred), v out from it, h up from the slab underside.
 * Returns `boxes` ({ u0, u1, v0, v1, h0, h1, role }); roles slab, solid (a parapet) or rail (bars and posts).
 */
export function balconyParts(style, width = 2) {
  const half = width / 2;
  const boxes = [{ u0: -half, u1: half, v0: 0, v1: 0.9, h0: 0, h1: 0.12, role: 'slab' }];
  if (style === 'solid') {
    boxes.push({ u0: -half, u1: half, v0: 0.82, v1: 0.9, h0: 0.12, h1: 1.05, role: 'solid' });
    boxes.push({ u0: -half, u1: -half + 0.08, v0: 0, v1: 0.9, h0: 0.12, h1: 1.05, role: 'solid' });
    boxes.push({ u0: half - 0.08, u1: half, v0: 0, v1: 0.9, h0: 0.12, h1: 1.05, role: 'solid' });
    return boxes;
  }
  boxes.push({ u0: -half, u1: half, v0: 0.84, v1: 0.9, h0: 1.0, h1: 1.05, role: 'rail' }); // top bar
  const posts = Math.max(3, Math.round(width / 0.28));
  for (let i = 0; i <= posts; i++) {
    const u = -half + 0.02 + ((width - 0.04) * i) / posts; // the end posts sit just inside the slab edge
    boxes.push({ u0: u - 0.015, u1: u + 0.015, v0: 0.84, v1: 0.9, h0: 0.12, h1: 1.0, role: 'rail' });
  }
  boxes.push({ u0: -half, u1: -half + 0.03, v0: 0, v1: 0.9, h0: 0.95, h1: 1.0, role: 'rail' });
  boxes.push({ u0: half - 0.03, u1: half, v0: 0, v1: 0.9, h0: 0.95, h1: 1.0, role: 'rail' });
  return boxes;
}

/**
 * Laundry on a balcony of `width` metres: a drying pole across the front with up to six items hanging from it
 * (shirts, towels) and, now and then, a futon over the railing. `amount` is a percentage; `rand` a 0..1 stream.
 * Items: { role: 'pole' | 'item' | 'futon', u0, u1, h0, h1, v, colour } with `v` the distance out from the wall.
 */
export function laundryItems(amount, width, rand) {
  const k = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  if (k === 0 || rand() > 0.35 + 0.65 * k) return [];
  const half = width / 2;
  const items = [{ role: 'pole', u0: -half, u1: half, h0: 2.0, h1: 2.04, v: 0.55, colour: BALCONY_COLOURS.pole }];
  const n = Math.min(6, Math.max(1, Math.round(k * 2 + rand() * k * 4)));
  const slot = (width - 0.2) / n;
  for (let i = 0; i < n; i++) {
    const w = Math.min(0.55, slot * 0.85);
    const u = -half + 0.1 + slot * (i + 0.5);
    const tall = 0.55 + rand() * 0.3;
    items.push({ role: 'item', u0: u - w / 2, u1: u + w / 2, h0: 2.0 - tall, h1: 2.0, v: 0.55, colour: LAUNDRY_COLOURS[Math.floor(rand() * LAUNDRY_COLOURS.length)] });
  }
  if (rand() < 0.3 * k) items.push({ role: 'futon', u0: -half * 0.7, u1: half * 0.7, h0: 0.55, h1: 1.35, v: 0.95, colour: BALCONY_COLOURS.futon });
  return items;
}
