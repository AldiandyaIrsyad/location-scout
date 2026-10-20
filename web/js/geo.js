// Local tangent-plane helpers. Local [x, y] = [east, north] meters from (lat0, lon0).
export const M_PER_DEG_LAT = 110574;

export function mPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

export function toLocal(lat, lon, lat0, lon0) {
  return [(lon - lon0) * mPerDegLon(lat0), (lat - lat0) * M_PER_DEG_LAT];
}

export function toLatLon(x, y, lat0, lon0) {
  return [lat0 + y / M_PER_DEG_LAT, lon0 + x / mPerDegLon(lat0)];
}

export function bboxFor(lat0, lon0, sizeMeters) {
  const half = sizeMeters / 2;
  const dLat = half / M_PER_DEG_LAT;
  const dLon = half / mPerDegLon(lat0);
  return { south: lat0 - dLat, west: lon0 - dLon, north: lat0 + dLat, east: lon0 + dLon };
}
