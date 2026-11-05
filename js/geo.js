// Location helpers. Kuhit only ever stores and shows approximate location:
// coordinates are rounded to 3 decimals (about 110 m) before they leave the device,
// and distance is shown as a bucket ("~50m"), never an exact number or a map pin.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export const CELL_PRECISION = 6; // geohash cell of about 1.2 km x 0.6 km

export function roundCoord(n) {
  return Math.round(n * 1000) / 1000;
}

export function geohash(lat, lng, precision = CELL_PRECISION) {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let hash = '', bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngLo = mid; } else { ch <<= 1; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

// The cell around a point plus its 8 neighbours, for the "nearby" query.
export function nearbyCells(lat, lng, precision = CELL_PRECISION) {
  const bits = precision * 5;
  const dLat = 180 / 2 ** Math.floor(bits / 2);
  const dLng = 360 / 2 ** Math.ceil(bits / 2);
  const cells = new Set();
  for (const a of [-1, 0, 1]) {
    for (const b of [-1, 0, 1]) {
      const la = Math.max(-89.999, Math.min(89.999, lat + a * dLat));
      let ln = lng + b * dLng;
      if (ln > 180) ln -= 360;
      if (ln < -180) ln += 360;
      cells.add(geohash(la, ln, precision));
    }
  }
  return [...cells];
}

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const NEARBY_RADIUS_M = 2000;

export function distanceLabel(m) {
  if (m < 120) return '~50m';
  if (m < 200) return '~100m';
  if (m < 400) return '~200m';
  if (m < 800) return '~500m';
  if (m < 1500) return '~1km';
  return '~2km';
}

// Kuhit's day runs on Philippine time (UTC+8): the daily kuhit limit resets at midnight there.
export function manilaDay(ms = Date.now()) {
  return Math.floor((ms + 8 * 3600 * 1000) / 86400000);
}
