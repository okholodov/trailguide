let metric = false;
export const setMetric = (m) => { metric = m; };
export const isMetric = () => metric;

const FT = 3.28084;
const MI = 1609.344;

/** Returns [value, unit]. */
export function dist(m) {
  if (metric) return m < 1000 ? [Math.round(m).toString(), 'm'] : [(m / 1000).toFixed(2), 'km'];
  return m < 0.1 * MI ? [(Math.round((m * FT) / 10) * 10).toLocaleString(), 'ft'] : [(m / MI).toFixed(2), 'mi'];
}

export function ele(m) {
  return metric ? [Math.round(m).toLocaleString(), 'm'] : [Math.round(m * FT).toLocaleString(), 'ft'];
}

export function short(m) {
  return metric ? `${Math.round(m)} m` : `${Math.round(m * FT).toLocaleString()} ft`;
}

export function speed(mps) {
  return metric ? [(mps * 3.6).toFixed(1), 'km/h'] : [(mps * 2.23694).toFixed(1), 'mph'];
}

/** sec per metre → "36:24", "/mi" */
export function pace(secPerM) {
  const unit = metric ? 1000 : MI;
  if (!Number.isFinite(secPerM) || secPerM <= 0) return ['—', metric ? '/km' : '/mi'];
  const s = Math.round(secPerM * unit);
  if (s >= 100 * 60) return ['—', metric ? '/km' : '/mi'];
  return [`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, metric ? '/km' : '/mi'];
}

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const profileScale = () => (metric ? { d: 1000, du: 'km', e: 1, eu: 'm' } : { d: MI, du: 'mi', e: FT, eu: 'ft' });
