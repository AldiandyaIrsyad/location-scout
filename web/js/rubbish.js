// Rubbish on the pavement, behind the "Street furniture" section of the World settings panel: wheelie bins, round litter
// bins and heaps of bin bags. Pure data and decisions, no rendering (render.js builds the pieces from binParts and bagPile).

export const BIN_COLOURS = { green: '#35603f', grey: '#7c8187', blue: '#2f5fa8', black: '#26282c' };
export const BIN_CHOICES = ['mixed', ...Object.keys(BIN_COLOURS)];
export const RUBBISH_KINDS = ['auto', 'bins', 'bags', 'mixed'];
export const BAG_COLOURS = ['#1d1e21', '#1d1e21', '#2b2d31', '#e3e5e6', '#3a62b0', '#c9ccce'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between rubbish spots at 100%: New York streets are piled high, Japan is the tidiest. */
export function rubbishSpacing(center) {
  if (inBox(center, 40, 41.2, -75, -73)) return 14;
  if (inBox(center, -11, 20, 95, 141)) return 22;
  if (inBox(center, 33, 39, 124, 132)) return 26; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 60;
  if (inBox(center, 35, 60, -12, 30)) return 36;
  return 50;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function rubbishChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/**
 * What stands at a spot, from the "Rubbish" type and `u` (0..1): 'bags', 'wheelie' or 'litter'. 'bins' gives wheelie bins
 * (60%) and litter bins (40%); 'mixed' splits bags 50% and bins 50%; 'auto' follows the place (bags mostly in New York,
 * Korea and Southeast Asia, bins mostly in Europe, half and half elsewhere). Unknown choices count as 'auto'.
 */
export function rubbishKind(choice, center, u) {
  const t = Math.max(0, Math.min(0.999, Number(u) || 0));
  let bagShare = 0.5;
  if (choice === 'bins') bagShare = 0;
  else if (choice === 'bags') bagShare = 1;
  else if (choice !== 'mixed') {
    if (inBox(center, 40, 41.2, -75, -73) || inBox(center, 33, 39, 124, 132) || inBox(center, -11, 20, 95, 141)) bagShare = 0.75;
    else if (inBox(center, 35, 60, -12, 30)) bagShare = 0.3;
  }
  if (t < bagShare) return 'bags';
  const rest = bagShare >= 1 ? 0 : (t - bagShare) / (1 - bagShare);
  return rest < 0.6 ? 'wheelie' : 'litter';
}

/** Body colour for a choice ('mixed' picks by `u`, 0..1); unknown choices count as mixed. */
export function binColour(choice, u) {
  const fixed = own(BIN_COLOURS, choice);
  if (fixed) return fixed;
  const all = Object.values(BIN_COLOURS);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, Number(u) || 0) * all.length))];
}

/** Colour of one bag, from `u`: mostly black, some white and blue. */
export function bagColour(u) {
  return BAG_COLOURS[Math.min(BAG_COLOURS.length - 1, Math.floor(Math.max(0, Number(u) || 0) * BAG_COLOURS.length))];
}

/**
 * A heap of bin bags in its own frame (u along the wall, v out from it, h up): `count` bags (2..8) as blobs
 * { u, v, h, r, sy }. The first ones sit on the ground in a ring, the rest are stacked on top. `rand` is a 0..1 source.
 */
export function bagPile(count, rand, size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const n = Math.max(2, Math.min(8, Math.floor(Number(count)) || 2));
  const base = Math.min(n, Math.ceil(n * 0.65));
  const bags = [];
  for (let i = 0; i < n; i++) {
    const r = (0.2 + rand() * 0.08) * k;
    if (i < base) {
      const a = (i / base) * Math.PI * 2 + rand() * 0.5;
      const d = base === 1 ? 0 : 0.26 * k;
      bags.push({ u: Math.cos(a) * d, v: Math.sin(a) * d * 0.8, h: r * 0.85, r, sy: 0.85 });
    } else {
      const under = bags[(i - base) % base];
      bags.push({ u: under.u * 0.4 + (rand() - 0.5) * 0.1, v: under.v * 0.4 + (rand() - 0.5) * 0.1, h: under.h + under.r * 0.85 + r * 0.45, r: r * 0.9, sy: 0.85 });
    }
  }
  return bags;
}

/**
 * A bin in its own frame (u across, v out, h up from the ground), `size` scales it (0.7..1.5). Returns the `boxes`
 * ({ u0, u1, v0, v1, h0, h1, role }, roles body, lid, wheel and band) and `cyl` ({ r, h0, h1 }, a litter bin's round body).
 */
export function binParts(kind, size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  if (kind === 'litter') {
    return {
      cyl: { r: 0.22 * k, h0: 0.12 * k, h1: 0.92 * k },
      boxes: [
        box(-0.16, 0.16, -0.16, 0.16, 0, 0.12, 'wheel'), // foot
        box(-0.26, 0.26, -0.26, 0.26, 0.92, 0.98, 'lid'),
        box(-0.24, 0.24, -0.24, 0.24, 0.6, 0.66, 'band'),
      ],
    };
  }
  return {
    cyl: null,
    boxes: [
      box(-0.28, 0.28, -0.3, 0.3, 0.12, 0.95, 'body'),
      box(-0.3, 0.3, -0.33, 0.33, 0.95, 1.03, 'lid'),
      box(-0.26, 0.26, -0.34, -0.3, 0.12, 0.3, 'wheel'), // axle block at the back
      box(-0.3, -0.22, -0.34, -0.24, 0, 0.2, 'wheel'),
      box(0.22, 0.3, -0.34, -0.24, 0, 0.2, 'wheel'),
    ],
  };
}
