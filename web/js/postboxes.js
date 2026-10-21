// Street post boxes, behind the "Street furniture" section of the World settings panel. Pure data and decisions, no
// rendering (render.js builds the cylinder and boxes from postboxParts). The design follows the place: the red
// cylinder of Japan and Korea, the yellow box of France, a red pillar box in Britain.

export const POSTBOX_STYLES = ['auto', 'cylinder', 'pillar', 'box'];
export const POSTBOX_COLOURS = { red: '#c8261f', yellow: '#f0c430', blue: '#2f5fa8', green: '#2f7a52' };

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** The design to build: a chosen one, or by place for 'auto' and unknown choices (cylinder in Asia, a box in France, a pillar elsewhere). */
export function postboxStyleFor(choice, center) {
  if (choice === 'cylinder' || choice === 'pillar' || choice === 'box') return choice;
  if (inBox(center, 24, 46, 122, 146) || inBox(center, 33, 39, 124, 132)) return 'cylinder';
  if (inBox(center, 41, 51.1, -5.5, 9.8)) return 'box'; // France
  return 'pillar';
}

/** Colour of the design in a place: red everywhere except yellow boxes in France and blue ones for a US-style mailbox (box, elsewhere). */
export function postboxColour(style, center) {
  if (style === 'box') return inBox(center, 41, 51.1, -5.5, 9.8) ? POSTBOX_COLOURS.yellow : POSTBOX_COLOURS.blue;
  return POSTBOX_COLOURS.red;
}

/** Metres of street between post boxes at 100%: one every few blocks. */
export function postboxSpacing(center) {
  return inBox(center, 24, 46, 122, 146) ? 70 : 110;
}

/** Chance that a street sample gets one: density is a percentage, `every` the sampling interval in metres. */
export function postboxChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/**
 * One post box in its own frame: u across (the way the slot faces is +v, towards the pavement), h up from the ground.
 * `size` scales it (0.7..1.5). Returns `cyl` (a round body: radius, height, base height) and `boxes`
 * ({ u0, u1, v0, v1, h0, h1, role }) with roles body, trim (the dark base and cap), slot and plate.
 * The cylinder style has its round body in `cyl`; the others are all boxes.
 */
export function postboxParts(style, size = 1) {
  const k = Math.max(0.7, Math.min(1.5, Number(size) || 1));
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  if (style === 'cylinder') {
    return {
      cyl: { r: 0.28 * k, h0: 0.12 * k, h1: 1.1 * k },
      boxes: [
        box(-0.2, 0.2, -0.2, 0.2, 0, 0.12, 'trim'), // base
        box(-0.3, 0.3, -0.3, 0.3, 1.1, 1.18, 'trim'), // cap
        box(-0.12, 0.12, 0.26, 0.3, 0.85, 0.89, 'slot'),
        box(-0.1, 0.1, 0.27, 0.3, 0.6, 0.72, 'plate'),
      ],
    };
  }
  if (style === 'box') {
    return {
      cyl: null,
      boxes: [
        box(-0.3, 0.3, -0.2, 0.2, 0.9, 1.4, 'body'), // the letter box on its legs
        box(-0.27, 0.27, 0.2, 0.22, 1.08, 1.12, 'slot'),
        box(-0.2, 0.2, 0.2, 0.22, 1.2, 1.32, 'plate'),
        box(-0.26, -0.2, -0.14, -0.08, 0, 0.9, 'trim'),
        box(0.2, 0.26, -0.14, -0.08, 0, 0.9, 'trim'),
      ],
    };
  }
  // pillar box: a rounded-off tall box with a domed cap and a slot
  return {
    cyl: null,
    boxes: [
      box(-0.26, 0.26, -0.26, 0.26, 0.1, 1.25, 'body'),
      box(-0.3, 0.3, -0.3, 0.3, 1.25, 1.35, 'trim'),
      box(-0.2, 0.2, -0.2, 0.2, 1.35, 1.42, 'trim'),
      box(-0.14, 0.14, 0.26, 0.28, 0.98, 1.02, 'slot'),
      box(-0.22, 0.22, -0.22, 0.22, 0, 0.1, 'trim'),
    ],
  };
}
