// Fallen leaves and petals under street trees, behind the "Trees" part of the World settings panel. Pure data and
// decisions, no rendering (render.js lays small flat diamonds on the ground from litterScatter).

export const LITTER_PALETTES = {
  autumn: ['#d9772b', '#c4432a', '#e6b134', '#8a5a2b', '#b8541f'],
  petals: ['#f4b6c9', '#f9d3de', '#eaa0b8', '#fbe6ec'],
  green: ['#6aa04f', '#4e8a48', '#8bb85a', '#7a8f45'],
};
export const LITTER_CHOICES = ['auto', ...Object.keys(LITTER_PALETTES)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** The palette name to use: a chosen one, or by season for 'auto' and unknown choices (none in winter). */
export function litterKind(choice, season) {
  if (own(LITTER_PALETTES, choice)) return choice;
  if (season === 'autumn') return 'autumn';
  if (season === 'spring') return 'petals';
  if (season === 'summer') return 'green';
  return null;
}

/** Number of pieces under one tree: the density is a percentage (100 = 14 pieces on average), `u` (0..1) varies it per tree. */
export function litterCount(density, u) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  const t = Math.max(0, Math.min(1, Number(u) || 0));
  return Math.round(d * 14 * (0.5 + t));
}

/** Colour of one piece of a palette ('autumn', ...) from `u` (0..1); an unknown name gives the autumn colours. */
export function litterColour(kind, u) {
  const set = own(LITTER_PALETTES, kind) || LITTER_PALETTES.autumn;
  return set[Math.min(set.length - 1, Math.floor(Math.max(0, Number(u) || 0) * set.length))];
}

/**
 * `count` pieces scattered round a tree trunk in a disc of `radius` metres, denser near the trunk: { dx, dy, rot, k }
 * with the offset from the trunk, a turn in radians and a size factor 0.7..1.3. `rand` is a 0..1 source.
 */
export function litterScatter(count, radius, rand) {
  const out = [];
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const a = rand() * Math.PI * 2;
    const d = radius * Math.pow(rand(), 0.75); // slightly thicker in the middle than a uniform disc
    out.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, rot: rand() * Math.PI, k: 0.7 + rand() * 0.6 });
  }
  return out;
}

/** The four corners of one piece (a leaf as a diamond) in its own frame, `size` in metres long, `k` the per-piece factor, `rot` its turn. */
export function litterShape(size, k, rot) {
  const L = (Math.max(0.5, Math.min(3, Number(size) || 1)) * 0.22 * k) / 2;
  const W = L * 0.55;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [[L, 0], [0, W], [-L, 0], [0, -W]].map(([x, y]) => [x * c - y * s, x * s + y * c]);
}
