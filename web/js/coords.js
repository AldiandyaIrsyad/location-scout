// Location parsing for the search box: map links, decimal and DMS coordinates and Plus Codes,
// all in the browser so input is instant. KML, KMZ and GeoJSON files are parsed by the server
// (see parseKmlFile below).
//
// parseLocation(text) -> { lat, lon, heading?, tilt?, range? } | null
// parseKmlFile(file)  -> { lat, lon, heading?, tilt?, name? } | null  (uploads the file)

const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
const NUM = '-?\\d+(?:\\.\\d+)?';

function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Parse a location from user input. Returns null when nothing matches.
 * Recognised formats (checked in this order):
 *  - Google Maps place pin  ...!3d<lat>!4d<lon>...
 *  - "@lat,lon" (Google Maps, Google Maps Street View, Google Earth web)
 *      Google Earth tail tokens: <n>h heading, <n>t tilt, <n>d range (<n>a altitude is ignored)
 *  - ?q= / ll= / center= / query= with "lat,lon"
 *  - OpenStreetMap  #map=zoom/lat/lon  or  mlat=..&mlon=..
 *  - decimal "lat, lon" (optional N/S/E/W suffixes)
 *  - DMS  35°39'34.2"N 139°42'01.8"E  (degree-minute-second or degree-minute)
 *  - Open Location Code full code, e.g. 8Q7XJPR2+X6 (short codes are not supported)
 */
export function parseLocation(text) {
  if (typeof text !== 'string') return null;
  const s = safeDecode(text.trim());
  if (!s) return null;
  return (
    parseGooglePin(s) ||
    parseAtCoords(s) ||
    parseQueryCoords(s) ||
    parseOsmUrl(s) ||
    parseDecimal(s) ||
    parseDms(s) ||
    parsePlusCode(s) ||
    null
  );
}

function parseGooglePin(s) {
  const m = s.match(new RegExp(`!3d(${NUM})!4d(${NUM})`));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return isValidLatLon(lat, lon) ? { lat, lon } : null;
}

// "@lat,lon" followed by optional comma-separated suffixed tokens (Google Earth / Street View).
function parseAtCoords(s) {
  const m = s.match(new RegExp(`@(${NUM}),(${NUM})((?:,${NUM}[a-zA-Z])*)`));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!isValidLatLon(lat, lon)) return null;
  const out = { lat, lon };
  const tokens = m[3].split(',').filter(Boolean);
  for (const tok of tokens) {
    const t = tok.match(/^(-?\d+(?:\.\d+)?)([a-zA-Z])$/);
    if (!t) continue;
    const v = parseFloat(t[1]);
    switch (t[2].toLowerCase()) {
      case 'h': out.heading = v; break;   // heading in degrees
      case 't': out.tilt = v; break;      // tilt in degrees
      case 'd': out.range = v; break;     // range in meters
      default: break;                     // a (altitude), y (fov), r (roll), z (zoom), m: ignored
    }
  }
  return out;
}

function parseQueryCoords(s) {
  const m =
    s.match(new RegExp(`[?&](?:q|ll|center|query|daddr|saddr)=(${NUM}),\\s*(${NUM})`, 'i')) ||
    s.match(new RegExp(`/search/(${NUM}),\\s*(${NUM})`));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return isValidLatLon(lat, lon) ? { lat, lon } : null;
}

function parseOsmUrl(s) {
  let m = s.match(new RegExp(`map=\\d+(?:\\.\\d+)?\\/(${NUM})\\/(${NUM})`));
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }
  const la = s.match(new RegExp(`mlat=(${NUM})`));
  const lo = s.match(new RegExp(`mlon=(${NUM})`));
  if (la && lo) {
    const lat = parseFloat(la[1]);
    const lon = parseFloat(lo[1]);
    if (isValidLatLon(lat, lon)) return { lat, lon };
  }
  return null;
}

// Whole-string decimal coordinates: "35.6595, 139.7005", "35.6595 139.7005", "35.6595N 139.7005E".
function parseDecimal(s) {
  const re = new RegExp(
    `^\\s*(${NUM})\\s*°?\\s*([NSns])?\\s*[,;\\s]\\s*(${NUM})\\s*°?\\s*([EWew])?\\s*$`
  );
  const m = s.match(re);
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
  return isValidLatLon(lat, lon) ? { lat, lon } : null;
}

// DMS / DM: 35°39'34.2"N 139°42'01.8"E  or  35°39.57'N 139°42.03'E
function parseDms(s) {
  if (!s.includes('°')) return null;
  const re = /(-?\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|′′|'')\s*)?([NSEWnsew])?/g;
  const found = [];
  for (const m of s.matchAll(re)) {
    const degStr = m[1];
    const deg = parseFloat(degStr);
    const min = m[2] ? parseFloat(m[2]) : 0;
    const sec = m[3] ? parseFloat(m[3]) : 0;
    if (!Number.isFinite(deg) || min >= 60 || sec >= 60) return null;
    const mag = Math.abs(deg) + min / 60 + sec / 3600;
    found.push({
      mag,
      neg: degStr.startsWith('-'),
      hem: m[4] ? m[4].toUpperCase() : null,
    });
  }
  if (found.length !== 2) return null;
  let [p1, p2] = found;
  // Hemisphere letters decide the order: E/W cannot be latitude, N/S cannot be longitude.
  if (p1.hem === 'E' || p1.hem === 'W' || p2.hem === 'N' || p2.hem === 'S') {
    [p1, p2] = [p2, p1];
  }
  const signed = (p) => {
    const negative = p.neg || p.hem === 'S' || p.hem === 'W';
    return negative ? -p.mag : p.mag;
  };
  const lat = signed(p1);
  const lon = signed(p2);
  return isValidLatLon(lat, lon) ? { lat, lon } : null;
}

// Full plus code only: 8 significant characters, '+', then 2 characters (10 digits).
function parsePlusCode(s) {
  const up = s.toUpperCase();
  const alpha = OLC_ALPHABET;
  const re = new RegExp(`([${alpha}]{8})\\+([${alpha}]{2})(?![${alpha}])`);
  const m = up.match(re);
  if (!m) return null;
  const pos = decodeOlc(m[1] + m[2]);
  return pos && isValidLatLon(pos.lat, pos.lon) ? pos : null;
}

/**
 * Decode a full Open Location Code (with or without '+') to the center of its cell.
 * Digits 1-10 are five lat/lon pairs (resolutions 20, 1, 0.05, 0.0025, 0.000125 degrees);
 * any further digits refine the cell on a 5-row x 4-column grid.
 */
export function decodeOlc(code) {
  const digits = String(code).toUpperCase().replace('+', '');
  if (digits.length < 10) return null;
  let lat = -90;
  let lon = -180;
  for (let p = 0; p < 5; p++) {
    const iLat = OLC_ALPHABET.indexOf(digits[2 * p]);
    const iLon = OLC_ALPHABET.indexOf(digits[2 * p + 1]);
    if (iLat < 0 || iLon < 0) return null;
    lat += iLat * OLC_PAIR_RES[p];
    lon += iLon * OLC_PAIR_RES[p];
  }
  let cellLat = 0.000125;
  let cellLon = 0.000125;
  for (let k = 10; k < digits.length; k++) {
    const v = OLC_ALPHABET.indexOf(digits[k]);
    if (v < 0) return null;
    cellLat /= 5;
    cellLon /= 4;
    lat += Math.floor(v / 4) * cellLat;
    lon += (v % 4) * cellLon;
  }
  return { lat: lat + cellLat / 2, lon: lon + cellLon / 2 };
}

/**
 * Upload a KML, KMZ or GeoJSON file; the server returns its first location. Resolves to null when the
 * file holds no location. Rejects on network or server errors (AbortError when aborted).
 */
export async function parseKmlFile(file, signal) {
  const form = new FormData();
  form.append('file', file, file?.name || 'upload');
  const res = await fetch('api/locate/file', { method: 'POST', body: form, signal });
  if (res.status === 422) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: keep the status text below */
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}
