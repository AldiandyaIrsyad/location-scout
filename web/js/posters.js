// Poster columns and advertising panels on the pavement, behind the "Street furniture" section of the World settings
// panel. Pure data and decisions, no rendering (render.js builds the pieces from posterParts). The Morris column of
// Paris and other European cities carries a ring of posters; elsewhere a two-sided panel on a pole does the same job.

export const POSTER_PALETTES = {
  warm: ['#d9472f', '#e8963a', '#f0c633', '#c4572f', '#f2e3c4', '#a83a3a'],
  cool: ['#2f64b5', '#3f8fb0', '#7fb8c8', '#274a7a', '#e6eef4', '#5c7cc2'],
  mono: ['#f1efe6', '#2b2d31', '#a9acb1', '#6d7077', '#d8d6cc', '#17181a'],
};
export const POSTER_CHOICES = ['mixed', ...Object.keys(POSTER_PALETTES)];
export const AD_STYLES = ['auto', 'column', 'panel'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between ad spots at 100%: Paris and the rest of France most, then Europe and Japan, then the rest. */
export function adSpacing(center) {
  if (inBox(center, 41, 51.1, -5.5, 9.8)) return 55;
  if (inBox(center, 35, 60, -12, 30)) return 90;
  if (inBox(center, 24, 46, 122, 146)) return 110;
  return 160;
}

/** Chance that a street sample gets a spot: density is a percentage, `every` the sampling interval in metres. */
export function adChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** The design to build: a chosen one, or by place for 'auto' and unknown choices (the column in Europe, a panel elsewhere). */
export function adKind(choice, center) {
  if (choice === 'column' || choice === 'panel') return choice;
  return inBox(center, 35, 60, -12, 30) ? 'column' : 'panel';
}

/** Poster colour for a palette choice ('mixed' draws from every palette by `u`, 0..1); unknown choices count as mixed. */
export function posterColour(choice, u) {
  const t = Math.max(0, Math.min(0.999, Number(u) || 0));
  const set = own(POSTER_PALETTES, choice) || Object.values(POSTER_PALETTES).flat();
  return set[Math.floor(t * set.length)];
}

/**
 * One ad structure in its own frame: h up from the ground, and for a panel u across it with the posters facing +-v.
 * `size` scales it (0.7..1.5). A column is `rings` ({ r, h0, h1, role }, roles base, band, cap, top) around its centre,
 * where the `band` is the poster ring (build it in `sectors` colours); a panel is `boxes`
 * ({ u0, u1, v0, v1, h0, h1, role }, roles frame and poster).
 */
export function posterParts(kind, size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  if (kind === 'column') {
    return {
      sectors: 10,
      rings: [
        { r: 0.62 * k, h0: 0, h1: 0.4 * k, role: 'base' },
        { r: 0.55 * k, h0: 0.4 * k, h1: 1.95 * k, role: 'band' },
        { r: 0.66 * k, h0: 1.95 * k, h1: 2.15 * k, role: 'cap' },
        { r: 0.4 * k, h0: 2.15 * k, h1: 2.45 * k, role: 'top' },
        { r: 0.16 * k, h0: 2.45 * k, h1: 2.75 * k, role: 'top' },
      ],
      boxes: [],
    };
  }
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  return {
    sectors: 0,
    rings: [],
    boxes: [
      box(-0.62, 0.62, -0.08, 0.08, 0.35, 2.15, 'frame'),
      box(-0.5, 0.5, 0.08, 0.1, 0.5, 2.0, 'poster'),
      box(-0.5, 0.5, -0.1, -0.08, 0.5, 2.0, 'poster'),
      box(-0.55, -0.45, -0.06, 0.06, 0, 0.35, 'frame'),
      box(0.45, 0.55, -0.06, 0.06, 0, 0.35, 'frame'),
    ],
  };
}
