// Potted plants and flower boxes against shop and house fronts, behind the "Street furniture" section of the World
// settings panel. Pure data and decisions, no rendering (render.js builds the boxes and leaf blobs from planterParts).

export const PLANTER_STYLES = ['mixed', 'pots', 'boxes', 'tubs'];
export const FLOWER_COLOURS = { pink: '#e9779f', red: '#d5312f', yellow: '#f0c633', white: '#f4f1e8', purple: '#8a5cc2' };
export const FLOWER_CHOICES = ['mixed', ...Object.keys(FLOWER_COLOURS)];
export const POT_COLOURS = { pot: '#b4623c', box: '#6c5844', tub: '#8a6a47', soil: '#3b2f27' };
export const LEAF_COLOURS = ['#4e8a48', '#5c9a4c', '#3f7a45', '#6aa04f'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between planter spots at 100%: Japanese alleys and old European streets have the most. */
export function planterSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 24; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 13;
  if (inBox(center, 35, 60, -12, 30)) return 16;
  if (inBox(center, -11, 6, 95, 141)) return 18;
  return 28;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function planterChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Flower colour for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function flowerColour(choice, u) {
  const fixed = own(FLOWER_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(FLOWER_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/** Kind of planter: a chosen style gives that kind; 'mixed' (and anything unknown) gives pots 50%, boxes 30%, tubs 20% by `u`. */
export function planterKind(style, u) {
  if (style === 'pots') return 'pot';
  if (style === 'boxes') return 'box';
  if (style === 'tubs') return 'tub';
  return u < 0.5 ? 'pot' : u < 0.8 ? 'box' : 'tub';
}

/** How many planters stand together: 1 to `max` (the "group" is a row along the wall), from `u`. */
export function planterCount(kind, u, max = 3) {
  const m = Math.max(1, Math.min(5, Math.floor(Number(max)) || 1));
  if (kind === 'box') return 1; // a window box is one long piece
  return 1 + Math.min(m - 1, Math.floor(Math.max(0, Math.min(0.999, u)) * m));
}

/** Width of one planter along the wall, so a row can be spaced. */
export function planterWidth(kind) {
  return kind === 'box' ? 1.1 : kind === 'tub' ? 0.75 : 0.45;
}

/**
 * One planter in its own frame: u across the wall (centred), v out from the wall, h up. `size` scales the plants
 * (0.5..2). Returns the `boxes` ({ u0, u1, v0, v1, h0, h1, role }, roles pot / soil) and the leaf and flower `blobs`
 * ({ u, v, h, r, role, sy }, roles leaf / flower; `sy` squashes the blob vertically). `rand` is a 0..1 stream.
 */
export function planterParts(kind, size, rand) {
  const k = Math.max(0.5, Math.min(2, Number(size) || 1));
  const boxes = [];
  const blobs = [];
  const blob = (u, v, h, r, role, sy = 1) => blobs.push({ u: u * k, v: v * k, h: h * k, r: r * k, role, sy });
  if (kind === 'box') {
    boxes.push({ u0: -0.55, u1: 0.55, v0: -0.14, v1: 0.14, h0: 0, h1: 0.3, role: 'box' });
    boxes.push({ u0: -0.52, u1: 0.52, v0: -0.11, v1: 0.11, h0: 0.3, h1: 0.33, role: 'soil' });
    for (let i = 0; i < 5; i++) blob(-0.44 + i * 0.22, (rand() - 0.5) * 0.06, 0.4, 0.13 + rand() * 0.04, 'leaf', 0.8);
    for (let i = 0; i < 6; i++) blob(-0.5 + i * 0.2 + (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.1, 0.5 + rand() * 0.07, 0.07, 'flower', 0.9);
    return { boxes: boxes.map((b) => scaleBox(b, k)), blobs };
  }
  if (kind === 'tub') {
    boxes.push({ u0: -0.3, u1: 0.3, v0: -0.3, v1: 0.3, h0: 0, h1: 0.55, role: 'tub' });
    boxes.push({ u0: -0.26, u1: 0.26, v0: -0.26, v1: 0.26, h0: 0.55, h1: 0.58, role: 'soil' });
    blob(0, 0, 0.95, 0.4, 'leaf', 1.1);
    blob(0.12, 0.05, 1.3, 0.28, 'leaf', 1);
    for (let i = 0; i < 4; i++) blob((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.4, 0.95 + rand() * 0.45, 0.07, 'flower');
    return { boxes: boxes.map((b) => scaleBox(b, k)), blobs };
  }
  // pot
  boxes.push({ u0: -0.17, u1: 0.17, v0: -0.17, v1: 0.17, h0: 0, h1: 0.3, role: 'pot' });
  boxes.push({ u0: -0.2, u1: 0.2, v0: -0.2, v1: 0.2, h0: 0.3, h1: 0.36, role: 'pot' });
  blob(0, 0, 0.62, 0.2, 'leaf', 1);
  blob(-0.13, 0.03, 0.55, 0.15, 'leaf', 0.9);
  blob(0.13, -0.03, 0.57, 0.15, 'leaf', 0.9);
  blob(0.02, 0.1, 0.74, 0.14, 'leaf', 0.9);
  for (let i = 0; i < 4; i++) blob((rand() - 0.5) * 0.4, (rand() - 0.5) * 0.4, 0.68 + rand() * 0.2, 0.06, 'flower');
  return { boxes: boxes.map((b) => scaleBox(b, k)), blobs };
}

function scaleBox(b, k) {
  return { ...b, u0: b.u0 * k, u1: b.u1 * k, v0: b.v0 * k, v1: b.v1 * k, h0: b.h0 * k, h1: b.h1 * k };
}
