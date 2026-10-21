// Choices for how buildings and street furniture look, behind the "Buildings" and "Street furniture"
// sections of the World settings panel. Pure data and decisions, no rendering.

export const BENCH_STYLES = ['park', 'backless', 'stone', 'picnic'];
export const BENCH_COLORS = { wood: '#9c6b3f', green: '#3f6b4a', black: '#2b2f33', white: '#e8e6df', blue: '#3d5f8f' };
export const BIN_STYLES = ['square', 'round'];

/**
 * A bench as boxes in the fixture's local frame: u runs the way it faces, v across it, h is height.
 * `role` picks the colour: 'seat' follows the bench colour, 'frame' is metal, 'stone' is fixed.
 */
export function benchParts(style) {
  const part = (u0, u1, v0, v1, h0, h1, role) => ({ u0, u1, v0, v1, h0, h1, role });
  switch (style) {
    case 'backless':
      return [part(-0.22, 0.22, -0.8, 0.8, 0.42, 0.47, 'seat'), part(-0.2, 0.2, -0.72, -0.64, 0, 0.42, 'frame'), part(-0.2, 0.2, 0.64, 0.72, 0, 0.42, 'frame')];
    case 'stone':
      return [part(-0.28, 0.28, -0.9, 0.9, 0, 0.45, 'stone')];
    case 'picnic':
      return [
        part(-0.4, 0.4, -0.75, 0.75, 0.72, 0.78, 'seat'), // table top
        part(-0.75, -0.4, -0.75, 0.75, 0.42, 0.47, 'seat'), // the two seats, one each side
        part(0.4, 0.75, -0.75, 0.75, 0.42, 0.47, 'seat'),
        part(-0.05, 0.05, -0.65, -0.55, 0, 0.72, 'frame'),
        part(-0.05, 0.05, 0.55, 0.65, 0, 0.72, 'frame'),
        part(-0.7, -0.45, -0.05, 0.05, 0, 0.42, 'frame'),
        part(0.45, 0.7, -0.05, 0.05, 0, 0.42, 'frame'),
      ];
    default: { // park bench: four seat slats, three back slats, side frames with armrests
      const parts = [];
      for (const u0 of [-0.22, -0.1, 0.02, 0.14]) parts.push(part(u0, u0 + 0.09, -0.8, 0.8, 0.42, 0.46, 'seat'));
      for (const h0 of [0.52, 0.64, 0.76]) parts.push(part(-0.27, -0.23, -0.8, 0.8, h0, h0 + 0.09, 'seat'));
      for (const v of [-0.72, 0.72]) {
        parts.push(part(-0.25, -0.19, v - 0.04, v + 0.04, 0, 0.9, 'frame')); // rear leg rising into the back post
        parts.push(part(0.12, 0.18, v - 0.04, v + 0.04, 0, 0.42, 'frame')); // front leg
        parts.push(part(-0.22, 0.2, v - 0.04, v + 0.04, 0.38, 0.42, 'frame')); // rail under the seat
        parts.push(part(-0.24, 0.2, v - 0.05, v + 0.05, 0.62, 0.66, 'frame')); // armrest
        parts.push(part(0.12, 0.17, v - 0.04, v + 0.04, 0.42, 0.62, 'frame')); // armrest post
      }
      return parts;
    }
  }
}

/**
 * How worn one bench is, for the "Bench condition" slider (0 = new, 100 = old and stained).
 * `rand` gives 0..1 values (one bench's own stream, so the same bench always looks the same).
 * seatShift: lightness change of the seat, -0.17..+0.17 at full wear; rust: 0..0.6 of the way from the
 * frame colour to rust; stains: dark patches on the seat, u / v / w / l as fractions of the seat (-1..1 and 0..1).
 */
export function benchWear(wear, rand) {
  const k = Math.max(0, Math.min(100, Number(wear) || 0)) / 100;
  if (k === 0) return { seatShift: 0, rust: 0, stains: [] };
  const seatShift = (rand() - 0.5) * 0.35 * k;
  const count = Math.round(k * (1 + 3 * rand()));
  const stains = [];
  for (let i = 0; i < count; i++) {
    stains.push({ u: (rand() * 2 - 1) * 0.7, v: (rand() * 2 - 1) * 0.85, w: 0.12 + 0.3 * rand(), l: 0.06 + 0.2 * rand() });
  }
  return { seatShift, rust: 0.6 * k * (0.5 + 0.5 * rand()), stains };
}

export const ROOF_COLORS = {
  zinc: ['#7e8b95', '#6f7c87', '#8a959d', '#76828c', '#5f6b75'],
  slate: ['#4f5963', '#3f4852', '#59626b', '#474f58'],
  terracotta: ['#a4614a', '#b06a4f', '#9a5a45', '#8e5a48'],
  copper: ['#6fa38d', '#7bb09a', '#64957f'],
  charcoal: ['#2f3338', '#383c42', '#26292d'],
};

export const WALL_TONES = {
  stone: ['#e9dfc6', '#e2d6ba', '#eee5cf', '#d8ccb0', '#f0e8d4'],
  white: ['#f4f2ec', '#eceae3', '#f8f6f0'],
  brick: ['#a9654e', '#b4705a', '#9c5a45', '#bb7a60'],
  grey: ['#b9bcbd', '#a7abad', '#c6c8c8', '#9ea2a4'],
};

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Seat colour for a bench colour choice; wood for anything unknown. */
export function benchColor(choice) {
  return own(BENCH_COLORS, choice) || BENCH_COLORS.wood;
}

/** Roof colours: the chosen set, or the place's own palette for 'auto' and anything unknown. */
export function roofColors(palette, choice) {
  return own(ROOF_COLORS, choice) || palette.roofs;
}

/** Wall colours for a building kind: the chosen tone, or the place's palette for 'auto' and anything unknown. */
export function wallColors(palette, kind, choice) {
  return own(WALL_TONES, choice) || palette.walls[kind] || palette.walls.default;
}

const MAPPED_PITCHED = ['pyramidal', 'hipped', 'gabled'];
const FORCED_PITCHED = ['pyramidal', 'hipped', 'gabled'];
const FORCED_MAX_HEIGHT = 30; // taller buildings are towers: they keep their flat top

/**
 * The roof shape to build, or null for a flat top.
 * `mapped` is the roof:shape tag, `style` the chosen roof type ('auto' follows the map, 'flat' flattens
 * everything, a pitched type puts that roof on every ordinary low building).
 * `plain` is true where a procedural roof cannot work (surroundings, low-poly, courtyards); `solid` marks
 * monuments and plinths, which only keep a mapped roof and never get a chosen one.
 */
export function roofShapeFor({ mapped, style, height, plain, solid }) {
  if (plain || style === 'flat') return null;
  const asMapped = MAPPED_PITCHED.includes(mapped) ? mapped : null;
  if (!FORCED_PITCHED.includes(style)) return asMapped;
  return solid || height > FORCED_MAX_HEIGHT ? asMapped : style;
}
