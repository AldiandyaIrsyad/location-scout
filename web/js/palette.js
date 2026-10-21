// Building colours. A region can restyle walls and roofs; everywhere else gets the generic palette.

const WALLS = {
  house: ['#f3e2c7', '#e9d4b5', '#f5ebd9', '#dcc7a6'],
  residential: ['#f3e2c7', '#e9d4b5', '#f5ebd9', '#dcc7a6'],
  apartments: ['#ece4d6', '#e3d7c4', '#d9d4c8'],
  commercial: ['#e7e2da', '#d6d0c5', '#efe8dd', '#cfc8ba'],
  retail: ['#e7e2da', '#d6d0c5', '#efe8dd', '#cfc8ba'],
  office: ['#d9dee3', '#cfd6dc', '#e4e8ec'],
  industrial: ['#b7b4ac', '#a9a69d', '#c4c1b8'],
  temple: ['#d9c48f', '#c7b07b'],
  school: ['#f0dfb8', '#e8d3a3'],
  default: ['#eee6d6', '#e3d6c0', '#d9cbb4', '#f3ede2', '#cfd7d8'],
};
const ROOFS = ['#8e5a48', '#6f6a68', '#5d6f8a', '#a4614a', '#5f5a55'];

// Paris: pale limestone walls, and roofs that are almost all zinc and slate (a few tile roofs remain).
const LIMESTONE = ['#e9dfc6', '#e2d6ba', '#eee5cf', '#d8ccb0', '#f0e8d4', '#ddd0b3'];
const PARIS = {
  name: 'paris',
  walls: {
    ...WALLS,
    house: LIMESTONE, residential: LIMESTONE, apartments: LIMESTONE,
    commercial: LIMESTONE, retail: LIMESTONE, school: LIMESTONE, temple: LIMESTONE,
    default: LIMESTONE,
  },
  roofs: ['#7e8b95', '#6f7c87', '#8a959d', '#76828c', '#5f6b75', '#4f5963', '#59626b', '#a4614a'],
};

const GENERIC = { name: 'generic', walls: WALLS, roofs: ROOFS };

// Inside the Paris ring road (the boulevard périphérique), with a little margin.
const REGIONS = [
  { palette: PARIS, contains: (c) => c.lat >= 48.815 && c.lat <= 48.903 && c.lon >= 2.224 && c.lon <= 2.47 },
];

/** The palette for an area centred on { lat, lon }. */
export function paletteFor(center) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) return GENERIC;
  return REGIONS.find((r) => r.contains(center))?.palette || GENERIC;
}
