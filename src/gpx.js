const kids = (el, tag) => Array.from(el.children).filter((c) => c.localName === tag);
const childText = (el, tag) => kids(el, tag)[0]?.textContent.trim() || null;
const all = (el, tag) => Array.from(el.getElementsByTagNameNS('*', tag));

function readPoint(el) {
  const lat = parseFloat(el.getAttribute('lat'));
  const lon = parseFloat(el.getAttribute('lon'));
  const eleText = childText(el, 'ele');
  const ele = eleText != null ? parseFloat(eleText) : null;
  return [lat, lon, Number.isFinite(ele) ? ele : null];
}

/** Parse GPX text into { name, points: [[lat, lon, ele]], waypoints: [{lat, lon, name}] }. */
export function parseGpx(text, fallbackName = 'Track') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'gpx') {
    throw new Error('This file is not a valid GPX file.');
  }
  const ok = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  let points = all(doc, 'trkpt').map(readPoint).filter(ok);
  if (points.length < 2) points = all(doc, 'rtept').map(readPoint).filter(ok);
  if (points.length < 2) throw new Error('No track or route found in this GPX file.');

  const waypoints = all(doc, 'wpt')
    .map((el) => { const [lat, lon] = readPoint(el); return { lat, lon, name: childText(el, 'name') || '' }; })
    .filter((w) => Number.isFinite(w.lat));

  const meta = kids(doc.documentElement, 'metadata')[0];
  const trk = all(doc, 'trk')[0] || all(doc, 'rte')[0];
  const name = (trk && childText(trk, 'name')) || (meta && childText(meta, 'name')) || fallbackName;

  // Drop consecutive duplicates; they add nothing and confuse bearings.
  const dedup = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  return { name, points: dedup, waypoints };
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** points: [[lat, lon, ele, timeMs?], ...] */
export function toGpx(name, points, waypoints = []) {
  const pt = (p, tag) => {
    let s = `<${tag} lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}">`;
    if (p[2] != null) s += `<ele>${p[2].toFixed(1)}</ele>`;
    if (p[3] != null) s += `<time>${new Date(p[3]).toISOString()}</time>`;
    return s + `</${tag}>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailGuide" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name></metadata>
${waypoints.map((w) => `<wpt lat="${w.lat}" lon="${w.lon}"><name>${esc(w.name)}</name></wpt>`).join('\n')}
<trk><name>${esc(name)}</name><trkseg>
${points.map((p) => pt(p, 'trkpt')).join('\n')}
</trkseg></trk>
</gpx>
`;
}
