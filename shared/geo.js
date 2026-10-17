// geo.js — lat/lng ↔ local flat metres.
//
// The beach is ~1 km across, so we treat the ground as flat around a chosen
// origin (an "equirectangular" projection). Error over 1 km is millimetres,
// far below GPS noise, and it means all zone maths can be plain x/y geometry.
//
//   x = metres east of origin
//   y = metres north of origin

export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

// Default map centre: Carrickfin Atlantic strand, west of the airport runway.
export const CARRICKFIN = { lat: 55.0465, lng: -8.3461 };

export function makeLocalFrame(lat0, lng0) {
  // One degree of latitude is always the same length; one degree of
  // longitude shrinks by cos(latitude) as you go north.
  const mPerDegLat = EARTH_RADIUS_M * DEG;
  const mPerDegLng = EARTH_RADIUS_M * DEG * Math.cos(lat0 * DEG);
  return {
    lat0, lng0,
    toXY(lat, lng) {
      return [(lng - lng0) * mPerDegLng, (lat - lat0) * mPerDegLat];
    },
    toLatLng(x, y) {
      return [lat0 + y / mPerDegLat, lng0 + x / mPerDegLng];
    },
  };
}

// Great-circle distance in metres (for sanity checks; local frame is enough
// for anything on the beach).
export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ---------- shapes (all in local metres, [x, y]) ----------

// Douglas–Peucker line simplification: drops points that lie within
// `tolM` metres of the line between their neighbours. Removes GPS wobble
// and the clusters left by pausing at corners, keeps the real shape.
export function simplify(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // t = how far along the segment the closest point is (0..1)
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pathLengthM(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Shoelace formula. Ring may or may not repeat its first point.
export function polygonAreaM2(ring) {
  let A = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    A += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(A / 2);
}
