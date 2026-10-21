// Wall-mounted air-conditioner outdoor units on the building fronts, behind the "Buildings" section of the World
// settings panel. Pure data and decisions, no rendering (render.js builds the boxes from acParts). Units hang between
// the windows (the window columns are 3 m wide with a 1.6 m window, so the gap is centred on every multiple of 3 m)
// at the height of the windows' middle (rows every 3.2 m).

export const AC_TONES = { white: '#e7e9ea', cream: '#dcd6c4', grey: '#b9bdc1', dirty: '#b3ab98' };
export const AC_CHOICES = ['mixed', ...Object.keys(AC_TONES)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between stacks of units at 100%: Asian apartment blocks are covered in them, Europe has few. */
export function acSpacing(center) {
  if (inBox(center, 33, 39, 124, 132)) return 9; // Korea first: its box lies inside the wider Japan box
  if (inBox(center, 24, 46, 122, 146)) return 8;
  if (inBox(center, -11, 6, 95, 141)) return 7;
  if (inBox(center, 35, 60, -12, 30)) return 40;
  return 24;
}

/** Chance that a street sample gets a stack: density is a percentage, `every` the sampling interval in metres. */
export function acChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Casing tone for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function acTone(choice, u) {
  const fixed = own(AC_TONES, choice);
  if (fixed) return fixed;
  const all = Object.values(AC_TONES);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/** The gap between two window columns nearest `u` along a wall: multiples of 3 m. */
export function gapCentre(u) {
  return (Math.round(u / 3) || 0) * 3; // || 0 turns -0 into 0
}

/**
 * World heights of the units on a wall whose ground is `ground` and whose building is `height` tall: the middle of
 * the window rows above the ground floor that fit under the roof (a row's windows span 0.8 to 2.5 m above a multiple
 * of 3.2, so the unit's base is 1.0 above it), each kept with chance `share` from the stream `rand`.
 */
export function unitHeights(ground, height, rand, share = 0.6) {
  const out = [];
  for (let m = Math.ceil((ground + 2.4 - 1.0) / 3.2); m * 3.2 + 1.0 + 0.6 <= ground + height - 0.4; m++) if (rand() < share) out.push(m * 3.2 + 1.0);
  return out;
}

/**
 * One unit in its own frame: u across the wall (centred), v out from it, h up from its base. Returns `boxes`
 * ({ u0, u1, v0, v1, h0, h1, role }) with roles casing, grille (the dark fan opening), bracket and pipe.
 */
export function acParts(size = 1) {
  const k = Math.max(0.6, Math.min(1.6, Number(size) || 1));
  const w = 0.8 * k;
  const h = 0.55 * k;
  return [
    { u0: -w / 2, u1: w / 2, v0: 0.06, v1: 0.06 + 0.3 * k, h0: 0, h1: h, role: 'casing' },
    { u0: -w * 0.34, u1: w * 0.34, v0: 0.06 + 0.3 * k, v1: 0.09 + 0.3 * k, h0: h * 0.18, h1: h * 0.82, role: 'grille' },
    { u0: -w * 0.42, u1: -w * 0.34, v0: 0, v1: 0.06, h0: -0.04, h1: 0.04, role: 'bracket' },
    { u0: w * 0.34, u1: w * 0.42, v0: 0, v1: 0.06, h0: -0.04, h1: 0.04, role: 'bracket' },
    { u0: w * 0.3, u1: w * 0.3 + 0.03, v0: 0, v1: 0.06, h0: h * 0.5, h1: h * 0.5 + 0.25 * k, role: 'pipe' },
  ];
}
