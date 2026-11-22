const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Elevation gain with a small dead band so GPS/DEM noise doesn't inflate it. */
export class GainCounter {
  constructor(threshold = 3, state) {
    this.threshold = threshold;
    this.ref = state?.ref ?? null;
    this.gain = state?.gain ?? 0;
    this.loss = state?.loss ?? 0;
  }
  push(ele) {
    if (ele == null || Number.isNaN(ele)) return;
    if (this.ref == null) { this.ref = ele; return; }
    const d = ele - this.ref;
    if (d >= this.threshold) { this.gain += d; this.ref = ele; }
    else if (d <= -this.threshold) { this.loss -= d; this.ref = ele; }
  }
  toJSON() { return { ref: this.ref, gain: this.gain, loss: this.loss }; }
}

/**
 * points: [[lat, lon, ele|null], ...]
 * Returns the track plus cumulative distance/gain arrays used for navigation.
 */
export function buildTrack(points) {
  const n = points.length;
  const cum = new Float64Array(n);
  const cumGain = new Float64Array(n);
  const gc = new GainCounter(2);
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let minEle = Infinity, maxEle = -Infinity, hasEle = false;
  for (let i = 0; i < n; i++) {
    const [lat, lon, ele] = points[i];
    if (i > 0) cum[i] = cum[i - 1] + haversine(points[i - 1][0], points[i - 1][1], lat, lon);
    gc.push(ele);
    cumGain[i] = gc.gain;
    if (ele != null) { hasEle = true; minEle = Math.min(minEle, ele); maxEle = Math.max(maxEle, ele); }
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  }
  return {
    points, cum, cumGain,
    total: cum[n - 1] || 0,
    gain: gc.gain, loss: gc.loss,
    hasEle, minEle: hasEle ? minEle : 0, maxEle: hasEle ? maxEle : 0,
    bounds: [[minLat, minLon], [maxLat, maxLon]],
  };
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Snap a position onto the track. `prevAlong` (metres) keeps us on the right
 * part of loops and out-and-backs where the track passes the same spot twice.
 */
export function locateOnTrack(track, lat, lon, prevAlong = null) {
  const p = track.points;
  if (p.length < 2) return null;
  const ky = 111132.954;
  const kx = 111319.49 * Math.cos(rad(lat));

  const search = (i0, i1) => {
    let best = null;
    for (let i = Math.max(0, i0); i < Math.min(p.length - 1, i1); i++) {
      const ax = (p[i][1] - lon) * kx, ay = (p[i][0] - lat) * ky;
      const bx = (p[i + 1][1] - lon) * kx, by = (p[i + 1][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d2 = px * px + py * py;
      if (!best || d2 < best.d2) best = { i, t, d2 };
    }
    return best;
  };

  let best = null;
  if (prevAlong != null) {
    const i0 = lowerBound(track.cum, prevAlong - 400) - 1;
    const i1 = lowerBound(track.cum, prevAlong + 1200) + 1;
    best = search(i0, i1);
    if (best && Math.sqrt(best.d2) > 60) best = null;
  }
  if (!best) best = search(0, p.length - 1);

  const { i, t } = best;
  const a = p[i], b = p[i + 1];
  const ele = a[2] != null && b[2] != null ? a[2] + t * (b[2] - a[2]) : (a[2] ?? b[2] ?? null);
  const along = track.cum[i] + t * (track.cum[i + 1] - track.cum[i]);
  const gainHere = track.cumGain[i] + t * (track.cumGain[i + 1] - track.cumGain[i]);
  return {
    index: i,
    along,
    offset: Math.sqrt(best.d2),
    ele,
    remaining: track.total - along,
    remainingGain: Math.max(0, track.gain - gainHere),
    latlng: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
  };
}

/** Point on the track at a given distance along it. */
export function pointAt(track, along) {
  const { cum, points: p } = track;
  const i = Math.min(Math.max(lowerBound(cum, along) - 1, 0), p.length - 2);
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (along - cum[i]) / span)) : 0;
  const a = p[i], b = p[i + 1];
  return {
    lat: a[0] + t * (b[0] - a[0]),
    lon: a[1] + t * (b[1] - a[1]),
    ele: a[2] != null && b[2] != null ? a[2] + t * (b[2] - a[2]) : null,
    bearing: bearing(a[0], a[1], b[0], b[1]),
  };
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
