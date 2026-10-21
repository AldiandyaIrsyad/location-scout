// Sport pitches: surface colour, line markings and equipment from OSM's sport / surface tags.
// OSM only maps the outline and the sport, so the court is drawn to the sport's standard layout,
// scaled down to fit when the mapped area is smaller. Court coordinates are metres: u along the
// long side, v across, origin at the centre.

const STANDARD = {
  basketball: [28, 15],
  football: [105, 68],
  futsal: [40, 20],
  tennis: [23.77, 10.97],
  volleyball: [18, 9],
  badminton: [13.4, 6.1],
};

const KIND_OF_SPORT = {
  basketball: 'basketball',
  soccer: 'football', football: 'football',
  futsal: 'futsal',
  tennis: 'tennis', padel: 'tennis',
  volleyball: 'volleyball', beachvolleyball: 'volleyball',
  badminton: 'badminton',
};

const SURFACE_COLORS = {
  grass: '#86bd6e', artificial_turf: '#4f9a62', clay: '#c9704a', sand: '#e8d49a',
  asphalt: '#8f9aa6', concrete: '#a3a9b0', paved: '#a3a9b0', paving_stones: '#b5b0a6',
  tartan: '#b8573f', rubber: '#b8573f', acrylic: '#4a7fb0',
};

const SPORT_COLORS = {
  basketball: '#b8573f', tennis: '#3f8f6b', volleyball: '#4a7fb0', badminton: '#4a7fb0',
  futsal: '#3f8f6b', football: '#86bd6e',
};

/** Which layout a sport tag gets: a known sport, 'multi' for mixed use, or 'generic' (outline only). */
export function courtKind(sport) {
  if (sport === 'multi') return 'multi';
  return KIND_OF_SPORT[sport] || 'generic';
}

/** Surface colour, or null when the tags say nothing and the pitch keeps the plain grass colour. */
export function courtSurface(sport, surface) {
  if (SURFACE_COLORS[surface]) return SURFACE_COLORS[surface];
  return SPORT_COLORS[KIND_OF_SPORT[sport]] || null;
}

/** Smallest rectangle around a ring: centre, yaw of the long side, and its length and width. */
export function pitchFrame(ring) {
  let best = null;
  for (let deg = 0; deg < 90; deg += 0.5) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of ring) {
      const u = x * c + y * s, v = -x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, a, c, s, u0, u1, v0, v1 };
  }
  const mu = (best.u0 + best.u1) / 2, mv = (best.v0 + best.v1) / 2;
  let length = best.u1 - best.u0, width = best.v1 - best.v0, yaw = best.a;
  if (width > length) { [length, width] = [width, length]; yaw += Math.PI / 2; }
  return { cx: mu * best.c - mv * best.s, cy: mu * best.s + mv * best.c, yaw, length, width };
}

/** Court coordinates to local map coordinates. */
export function courtToLocal(frame, u, v) {
  const c = Math.cos(frame.yaw), s = Math.sin(frame.yaw);
  return [frame.cx + u * c - v * s, frame.cy + u * s + v * c];
}

const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]];
const seg = (u0, v0, u1, v1) => [[u0, v0], [u1, v1]];

function arc(cu, cv, r, a0, a1, toward = 1) {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 0.2));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cu - toward * r * Math.cos(a), cv + r * Math.sin(a)]);
  }
  return out;
}
const circle = (cu, cv, r) => arc(cu, cv, r, 0, Math.PI * 2);

// Markings in standard court metres, centred on the origin. `s` is +1 / -1 for the two ends.
const LAYOUTS = {
  basketball(hl, hw) {
    const lines = [rect(-hl, -hw, hl, hw), seg(0, -hw, 0, hw), circle(0, 0, 1.8)];
    const props = [];
    const corner = Math.asin(6.6 / 6.75);
    for (const s of [-1, 1]) {
      lines.push(rect(s * hl, -2.45, s * (hl - 5.8), 2.45));
      lines.push(arc(s * (hl - 5.8), 0, 1.8, -Math.PI / 2, Math.PI / 2, s));
      lines.push([
        [s * hl, -6.6], [s * (hl - 2.99), -6.6],
        ...arc(s * (hl - 1.575), 0, 6.75, -corner, corner, s),
        [s * (hl - 2.99), 6.6], [s * hl, 6.6],
      ]);
      props.push({ type: 'hoop', u: s * hl, v: 0, dir: -s });
    }
    return { lines, props };
  },
  football(hl, hw) {
    const lines = [rect(-hl, -hw, hl, hw), seg(0, -hw, 0, hw), circle(0, 0, 9.15)];
    const props = [];
    const box = 16.5, markDist = 11, arcAngle = Math.acos((box - markDist) / 9.15);
    for (const s of [-1, 1]) {
      lines.push(rect(s * hl, -20.16, s * (hl - box), 20.16));
      lines.push(rect(s * hl, -9.16, s * (hl - 5.5), 9.16));
      lines.push(arc(s * (hl - markDist), 0, 9.15, -arcAngle, arcAngle, s));
      props.push({ type: 'goal', u: s * hl, v: 0, dir: -s, width: 7.32, height: 2.44 });
    }
    return { lines, props };
  },
  futsal(hl, hw) {
    const lines = [rect(-hl, -hw, hl, hw), seg(0, -hw, 0, hw), circle(0, 0, 3)];
    const props = [];
    for (const s of [-1, 1]) {
      lines.push(arc(s * hl, 0, 6, -Math.PI / 2, Math.PI / 2, s));
      props.push({ type: 'goal', u: s * hl, v: 0, dir: -s, width: 3, height: 2 });
    }
    return { lines, props };
  },
  tennis(hl, hw) {
    const single = 4.115;
    return {
      lines: [
        rect(-hl, -hw, hl, hw),
        seg(-hl, -single, hl, -single), seg(-hl, single, hl, single),
        seg(-6.4, -single, -6.4, single), seg(6.4, -single, 6.4, single),
        seg(-6.4, 0, 6.4, 0),
      ],
      props: [{ type: 'net', u: 0, v: 0, span: 2 * hw + 0.9, height: 1.07 }],
    };
  },
  volleyball(hl, hw) {
    return {
      lines: [rect(-hl, -hw, hl, hw), seg(0, -hw, 0, hw), seg(-3, -hw, -3, hw), seg(3, -hw, 3, hw)],
      props: [{ type: 'net', u: 0, v: 0, span: 2 * hw + 1, height: 2.43 }],
    };
  },
  badminton(hl, hw) {
    const single = 2.59, shortService = 1.98, longService = hl - 0.76;
    return {
      lines: [
        rect(-hl, -hw, hl, hw),
        seg(-hl, -single, hl, -single), seg(-hl, single, hl, single),
        seg(-shortService, -hw, -shortService, hw), seg(shortService, -hw, shortService, hw),
        seg(-longService, -hw, -longService, hw), seg(longService, -hw, longService, hw),
        seg(shortService, 0, hl, 0), seg(-shortService, 0, -hl, 0),
      ],
      props: [{ type: 'net', u: 0, v: 0, span: 2 * hw + 0.8, height: 1.55 }],
    };
  },
  multi(hl, hw) {
    return { lines: [rect(-hl, -hw, hl, hw), seg(0, -hw, 0, hw)], props: [] };
  },
  generic(hl, hw) {
    return { lines: [rect(-hl, -hw, hl, hw)], props: [] };
  },
};

/**
 * Markings and equipment for a pitch of the given mapped size. The court never exceeds its standard
 * size and leaves a run-off margin inside the mapped outline; a smaller pitch gets a scaled court.
 */
export function courtLayout(kind, length, width) {
  const std = STANDARD[kind] || [length * 0.92, width * 0.92];
  const cl = Math.min(std[0], length * 0.92);
  const cw = Math.min(std[1], width * 0.92);
  const sx = cl / std[0], sy = cw / std[1];
  const { lines, props } = LAYOUTS[kind](std[0] / 2, std[1] / 2);
  return {
    length: cl, width: cw,
    lines: lines.map((line) => line.map(([u, v]) => [u * sx, v * sy])),
    props: props.map((p) => ({
      ...p,
      u: p.u * sx, v: p.v * sy,
      ...(p.width ? { width: Math.min(p.width, cw * 0.6) } : {}),
      ...(p.span ? { span: Math.min(p.span, width) } : {}),
    })),
  };
}
