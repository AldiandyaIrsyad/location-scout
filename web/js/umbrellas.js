// Umbrellas carried by the street figures, behind the "People" section of the World settings panel. Pure data and
// decisions, no rendering (render.js builds one canopy and pole per umbrella from umbrellaParts).

export const UMBRELLA_COLOURS = {
  clear: '#dfe9ee',
  black: '#25272b',
  navy: '#27386b',
  red: '#b3302b',
  yellow: '#e3b92f',
  pink: '#e08aa8',
  green: '#3f7a54',
};
export const UMBRELLA_CHOICES = ['mixed', ...Object.keys(UMBRELLA_COLOURS)];
// weights for 'mixed': black and clear (a vinyl umbrella, the Japanese konbini kind) are the most common
const MIXED = ['black', 'black', 'black', 'clear', 'clear', 'navy', 'red', 'yellow', 'pink', 'green'];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Whether this figure carries one: share is a percentage, `u` a 0..1 draw unique to the figure. */
export function hasUmbrella(share, u) {
  const s = Math.max(0, Math.min(100, Number(share) || 0)) / 100;
  return (Number(u) || 0) < s;
}

/** Canopy colour for a choice ('mixed' picks from the weighted list by `u`, 0..1); unknown choices count as mixed. */
export function umbrellaColour(choice, u) {
  const fixed = own(UMBRELLA_COLOURS, choice);
  if (fixed) return fixed;
  const t = Math.max(0, Math.min(0.999, Number(u) || 0));
  return UMBRELLA_COLOURS[MIXED[Math.floor(t * MIXED.length)]];
}

/**
 * An umbrella in its figure's frame (feet at y = 0, facing +z, x to the figure's right): `canopy` is a shallow cone
 * ({ x, y, z, r, h }: apex at y + h, rim at y) and `pole` runs from the hand to the apex ({ from, to }, 3-vectors).
 * `size` scales the canopy (0.7..1.5).
 */
export function umbrellaParts(size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  return {
    canopy: { x: 0.12, y: 1.9, z: 0.08, r: 0.52 * k, h: 0.2 * k },
    pole: { from: [0.24, 0.88, 0.08], to: [0.12, 1.9 + 0.2 * k, 0.08] },
  };
}
