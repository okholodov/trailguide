import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { db } from './db.js';
import { parseGpx, toGpx } from './gpx.js';
import { buildTrack, locateOnTrack, pointAt, bearing } from './geo.js';
import { LAYERS, CachedTileLayer, tilesForTrack, downloadTiles, clearTiles } from './tiles.js';
import { watchGps, watchCompass, simulateWalk } from './gps.js';
import { Recorder } from './recorder.js';
import { drawProfile } from './profile.js';
import * as U from './units.js';

const $ = (id) => document.getElementById(id);
const OFF_TRACK_M = 50;

// ---------- state ----------
const settings = { layer: 'usgs', dark: true, keepAwake: true, units: 'imperial' };
const tracks = new Map(); // id -> stored track
let active = null; // { stored, nav }
let fix = null;
let lastFixAt = 0;
let compass = null; // { heading, at }
let follow = true;
let loc = null; // position snapped onto active track
// How far along the track you've got. Only advances while you're actually near the
// track, so standing 60 miles away doesn't count as "halfway done".
let progressAlong = null;
const NEAR_TRACK_M = 300;
let rec = new Recorder();
let simStop = null;
const downloads = new Map(); // track id -> { done, total, controller }
let profileX = null;

// ---------- map ----------
const map = L.map('map', { zoomControl: false, maxZoom: 18, worldCopyJump: true }).setView([39.8, -98.6], 4);
map.attributionControl.setPrefix(false);
let baseLayer = null;
let scaleCtl = null;

function setBaseLayer() {
  if (baseLayer) map.removeLayer(baseLayer);
  const l = LAYERS[settings.layer];
  baseLayer = new CachedTileLayer(l.url, { maxNativeZoom: l.maxNativeZoom, maxZoom: 18, attribution: l.attribution }).addTo(map);
  document.body.classList.toggle('dark-map', settings.dark);
}

function setScale() {
  scaleCtl?.remove();
  scaleCtl = L.control.scale({ position: 'topleft', imperial: !U.isMetric(), metric: U.isMetric(), maxWidth: 140 }).addTo(map);
}

const trackLayer = L.layerGroup().addTo(map);
map.createPane('crumb').style.zIndex = 450; // walked path above the planned track
const crumbLine = L.polyline([], { pane: 'crumb', color: '#2f9bf0', weight: 5, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(map);
const accCircle = L.circle([0, 0], { radius: 0, color: '#4b8dff', weight: 1, opacity: 0.5, fillOpacity: 0.12, interactive: false });
const meIcon = L.divIcon({
  className: 'me-icon',
  iconSize: [56, 56],
  html: '<div class="me"><div class="halo"></div><svg class="arrow" viewBox="0 0 40 40"><path d="M20 5 31 33 20 27 9 33z"/></svg><div class="dot"></div></div>',
});
const meMarker = L.marker([0, 0], { icon: meIcon, interactive: false, zIndexOffset: 1000 });
const scrubMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#ff9f1a', fillOpacity: 1 });

map.on('dragstart', () => setFollow(false));

function sheetHeight() { return $('sheet').getBoundingClientRect().height; }

function centerOn(latlng, zoom = map.getZoom(), animate = true) {
  const p = map.project(latlng, zoom).add([0, sheetHeight() / 2 - 30]);
  map.setView(map.unproject(p, zoom), zoom, { animate });
}

function fitTrack() {
  if (!active) return;
  setFollow(false); // otherwise the next GPS fix pulls the map back to you
  map.fitBounds(active.nav.bounds, { paddingTopLeft: [30, 90], paddingBottomRight: [30, sheetHeight() + 20] });
}

function setFollow(on) {
  follow = on;
  $('btn-locate').classList.toggle('on', on);
}

// ---------- tracks ----------
function drawActiveTrack() {
  trackLayer.clearLayers();
  if (!active) return;
  const pts = active.stored.points.map((p) => [p[0], p[1]]);
  L.polyline(pts, { color: '#0d2a12', weight: 9, opacity: 0.5, interactive: false }).addTo(trackLayer);
  L.polyline(pts, { color: '#86e35b', weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(trackLayer);
  const endIcon = (cls) => L.divIcon({ className: '', iconSize: [22, 22], html: `<div class="pin ${cls}"></div>` });
  const first = pts[0], last = pts[pts.length - 1];
  const loop = L.latLng(first).distanceTo(last) < 30;
  L.marker(last, { icon: endIcon('finish'), interactive: false }).addTo(trackLayer);
  L.marker(first, { icon: endIcon(loop ? 'start loop' : 'start'), interactive: false }).addTo(trackLayer);
  for (const w of active.stored.waypoints || []) {
    L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="wpt"><i></i><span>${escapeHtml(w.name)}</span></div>` }),
      interactive: false,
    }).addTo(trackLayer);
  }
}

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function setActive(id, { fit = true } = {}) {
  const stored = id && tracks.get(id);
  active = stored ? { stored, nav: buildTrack(stored.points) } : null;
  loc = null;
  progressAlong = null;
  if (stored) { stored.lastOpenedAt = Date.now(); await db.putTrack(stored); }
  await db.set('activeTrackId', active ? id : null);
  drawActiveTrack();
  if (fit) fitTrack();
  updateLocation();
  updateFindTrack();
  render();
  renderTrackList();
  updateWakeLock();
}

async function addTrack(parsed, source = 'import') {
  const nav = buildTrack(parsed.points);
  const stored = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: parsed.name,
    points: parsed.points,
    waypoints: parsed.waypoints || [],
    createdAt: Date.now(),
    source,
    distance: nav.total,
    gain: nav.gain,
    offline: null,
  };
  tracks.set(stored.id, stored);
  await db.putTrack(stored);
  return stored;
}

/**
 * In-app yes/no sheet. Replaces window.confirm/alert, which in iOS home-screen apps
 * can block the page without ever showing (e.g. right after the Files picker closes).
 */
function ask(title, text, yes = 'OK', no = 'Cancel') {
  const dlg = $('dlg-ask');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-yes').textContent = yes;
  $('ask-no').textContent = no || '';
  $('ask-no').hidden = !no;
  return new Promise((resolve) => {
    const done = (v) => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(v); };
    $('ask-yes').onclick = () => done(true);
    $('ask-no').onclick = () => done(false);
    dlg.onclose = () => done(false);
    for (const d of document.querySelectorAll('dialog[open]')) if (d !== dlg) d.close();
    dlg.showModal();
  });
}
const tell = (title, text) => ask(title, text, 'OK', null);

/** Resolve once the page is visible again and has painted (iOS returns from the Files picker hidden). */
function whenVisible() {
  return new Promise((resolve) => {
    const go = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (document.visibilityState === 'visible') go();
    else document.addEventListener('visibilitychange', function h() {
      if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', h); go(); }
    });
  });
}

/** Import one or more GPX files; opens the last one and offers to save offline maps. */
async function importFiles(files) {
  await whenVisible();
  // Ask iOS/Chrome not to clear our data when the phone is low on space.
  navigator.storage?.persist?.();
  const added = [];
  const errors = [];
  for (const f of files) {
    try {
      const parsed = parseGpx(await f.text(), f.name.replace(/\.gpx$/i, ''));
      added.push(await addTrack(parsed));
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }
  $('dlg-tracks').close();
  if (errors.length) await tell('Could not import', errors.join('\n'));
  if (!added.length) return;
  await setActive(added[added.length - 1].id);
  if (!navigator.onLine) {
    toast(added.length === 1 ? `Saved "${added[0].name}" to My tracks` : `Saved ${added.length} tracks to My tracks`, 3500);
    return;
  }
  const tiles = added.reduce((n, t) => n + tilesForTrack(t.points, settings.layer).length, 0);
  const mb = Math.max(1, Math.round((tiles * 20) / 1024));
  const saved = added.length === 1 ? `"${added[0].name}" is saved to My tracks.` : `${added.length} tracks are saved to My tracks.`;
  const ok = await ask('Save map for offline use?', `${saved}\n\nDownload the map along ${added.length === 1 ? 'it' : 'them'} now, while you have signal? About ${tiles} tiles (~${mb} MB).`, 'Save offline map', 'Not now');
  if (ok) for (const t of added) await startDownload(t);
}

const openTracks = () => { renderTrackList(); $('dlg-tracks').showModal(); };

async function startDownload(stored) {
  if (downloads.has(stored.id)) return;
  navigator.storage?.persist?.();
  const layer = settings.layer;
  const keys = tilesForTrack(stored.points, layer);
  const controller = new AbortController();
  const d = { done: 0, total: keys.length, controller };
  downloads.set(stored.id, d);
  renderTrackList();
  toast(`Saving offline map for ${stored.name}…`, 0);
  try {
    const res = await downloadTiles(layer, keys, (s) => {
      d.done = s.done;
      toast(`Saving offline map… ${Math.round((s.done / s.total) * 100)}%`, 0);
      updateDownloadRow(stored.id);
    }, controller.signal);
    if (controller.signal.aborted) { toast('Offline map download cancelled'); return; }
    const prev = stored.offline?.layers || {};
    stored.offline = { layers: { ...prev, [layer]: { tiles: keys.length - res.failed, failed: res.failed, at: Date.now() } } };
    await db.putTrack(stored);
    toast(res.failed ? `Offline map saved, but ${res.failed} tiles failed. Tap Download again to retry.` : 'Offline map saved ✓', 4000);
  } catch (e) {
    toast(`Download failed: ${e.message}`, 5000);
  } finally {
    downloads.delete(stored.id);
    renderTrackList();
  }
}

function fmtDist(m) { const [v, u] = U.dist(m); return `${v} ${u}`; }

function renderTrackList() {
  const ul = $('track-list');
  if (!ul) return;
  const recent = (t) => t.lastOpenedAt || t.createdAt;
  const list = [...tracks.values()].sort((a, b) => recent(b) - recent(a));
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No tracks yet. Import a GPX file from Files, AllTrails, CalTopo, Gaia, etc.</li>';
    return;
  }
  ul.innerHTML = list.map((t) => {
    const isActive = active?.stored.id === t.id;
    const off = t.offline?.layers?.[settings.layer];
    const dl = downloads.get(t.id);
    const offlineLabel = dl
      ? `<span class="dl" data-dl="${t.id}">Saving map ${Math.round((dl.done / dl.total) * 100)}%</span>`
      : off ? `<span class="ok">Offline map ✓</span>` : `<span class="warn">Map not saved offline</span>`;
    return `<li class="${isActive ? 'active' : ''}" data-id="${t.id}">
      <div class="t-main" data-act="nav">
        <div class="t-title"><b>${escapeHtml(t.name)}</b>${isActive ? '<span class="tag">Open</span>' : '<span class="go">›</span>'}</div>
        <span class="muted">${fmtDist(t.distance)} · ↑ ${U.short(t.gain)}${t.source === 'recorded' ? ' · recorded' : ''}</span>
        ${offlineLabel}
      </div>
      <div class="t-btns">
        <button class="btn sm ghost" data-act="${dl ? 'cancel' : 'dl'}">${dl ? 'Cancel' : off ? 'Update map' : 'Save map'}</button>
        <button class="btn sm ghost" data-act="rename">Rename</button>
        <button class="btn sm ghost" data-act="export">Export</button>
        <button class="btn sm ghost danger" data-act="del">Delete</button>
      </div>
    </li>`;
  }).join('');
}

function updateDownloadRow(id) {
  const el = document.querySelector(`[data-dl="${id}"]`);
  const d = downloads.get(id);
  if (el && d) el.textContent = `Saving map ${Math.round((d.done / d.total) * 100)}%`;
}

$('track-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const t = tracks.get(id);
  switch (btn.dataset.act) {
    case 'nav':
      $('dlg-tracks').close();
      if (active?.stored.id !== id) { await setActive(id); toast(`Opened "${t.name}"`); }
      else fitTrack();
      break;
    case 'rename': {
      const name = prompt('Track name', t.name)?.trim();
      if (!name) return;
      t.name = name;
      await db.putTrack(t);
      renderTrackList();
      render();
      break;
    }
    case 'dl': startDownload(t); break;
    case 'cancel': downloads.get(id)?.controller.abort(); break;
    case 'export': shareGpx(t.name, t.recordedPoints || t.points, t.waypoints); break;
    case 'del':
      if (!(await ask('Delete track?', `"${t.name}" will be removed from My tracks. Saved map tiles are kept.`, 'Delete', 'Cancel'))) return;
      tracks.delete(id);
      await db.deleteTrack(id);
      if (active?.stored.id === id) await setActive(null, { fit: false });
      renderTrackList();
      break;
  }
});

$('file-gpx').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await importFiles(files);
});

$('btn-sample').addEventListener('click', async () => {
  try {
    const res = await fetch('./samples/tammany-loop.gpx');
    await importFiles([new File([await res.text()], 'tammany-loop.gpx')]);
  } catch (err) { tell('Could not load sample', err.message); }
});

$('btn-open-tracks').addEventListener('click', openTracks);
$('track-chip').addEventListener('click', openTracks);
$('track-zoom').addEventListener('click', () => (active ? fitTrack() : openTracks()));

async function shareGpx(name, points, waypoints) {
  const safe = name.replace(/[^\w\- ]+/g, '').trim() || 'track';
  const file = new File([toGpx(name, points, waypoints)], `${safe}.gpx`, { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- GPS ----------
function onFix(f) {
  if (simStop && !f.simulated) return;
  gpsError = null;
  fix = f;
  lastFixAt = Date.now();
  if (!map.hasLayer(meMarker)) {
    meMarker.addTo(map);
    accCircle.addTo(map);
    if (follow) centerOn([f.lat, f.lon], Math.max(map.getZoom(), 15), false);
  }
  updateLocation();

  const trackEle = loc && loc.offset < 40 ? loc.ele : null;
  const gpsEle = f.alt != null && (f.altAcc == null || f.altAcc < 25) ? f.alt : null;
  if (rec.add(f, trackEle ?? gpsEle)) {
    crumbLine.addLatLng([f.lat, f.lon]);
    saveRecSoon();
  }
  meMarker.setLatLng([f.lat, f.lon]);
  accCircle.setLatLng([f.lat, f.lon]).setRadius(f.acc || 0);
  if (follow) centerOn([f.lat, f.lon]);
  updateHeading();
  updateBadge();
  render();
}

let gpsError = null;
function onGpsError(err) {
  gpsError = err;
  const badge = $('gps-badge');
  badge.className = 'badge none';
  if (err.code === 1) {
    badge.querySelector('.label').textContent = 'Location off';
    toast('Location access is off. Turn it on in Settings → Privacy & Security → Location Services → Safari Websites (choose While Using), then reopen the app.', 9000);
  } else {
    badge.querySelector('.label').textContent = 'No GPS';
  }
}

function updateLocation() {
  if (!active || !fix) { loc = null; return; }
  loc = locateOnTrack(active.nav, fix.lat, fix.lon, progressAlong);
  if (loc.offset <= NEAR_TRACK_M) progressAlong = loc.along;
}

function updateHeading() {
  const el = meMarker.getElement();
  if (!el) return;
  let h = null;
  if (compass && Date.now() - compass.at < 3000) h = compass.heading;
  else if (fix?.heading != null && !Number.isNaN(fix.heading) && (fix.speed ?? 0) > 0.4) h = fix.heading;
  const me = el.querySelector('.me');
  me.classList.toggle('has-heading', h != null);
  if (h != null) me.querySelector('.arrow').style.transform = `rotate(${h}deg)`;
}

function updateBadge() {
  const badge = $('gps-badge');
  const label = badge.querySelector('.label');
  const stale = !fix || Date.now() - lastFixAt > 20000;
  if (stale && gpsError) return; // keep the error message from onGpsError
  let cls, text;
  if (stale) { cls = fix ? 'weak' : 'searching'; text = fix ? 'GPS lost' : 'Searching GPS…'; }
  else if (fix.simulated) { cls = 'strong'; text = 'Simulated GPS'; }
  else if (fix.acc <= 10) { cls = 'strong'; text = 'Strong GPS'; }
  else if (fix.acc <= 25) { cls = 'good'; text = 'Good GPS'; }
  else { cls = 'weak'; text = `Weak GPS ±${U.short(fix.acc)}`; }
  badge.className = `badge ${cls}`;
  label.textContent = text;
}

$('btn-compass').addEventListener('click', async () => {
  try {
    await watchCompass((heading) => { compass = { heading, at: Date.now() }; updateHeading(); });
    $('btn-compass').classList.add('on');
    toast('Compass on: the arrow shows where you are facing');
  } catch (e) { toast(e.message); }
});

$('btn-locate').addEventListener('click', () => {
  if (!fix) { toast('Waiting for a GPS fix…'); return; }
  setFollow(true);
  centerOn([fix.lat, fix.lon], Math.max(map.getZoom(), 15));
});

$('btn-fit').addEventListener('click', () => {
  if (!active) { openTracks(); return; }
  fitTrack();
});
$('find-track').addEventListener('click', fitTrack);

// "Show track" pill when the open track is completely off-screen.
function updateFindTrack() {
  const pill = $('find-track');
  if (!active || map.getBounds().intersects(active.nav.bounds)) { pill.hidden = true; return; }
  const c = map.getCenter();
  const from = fix ? [fix.lat, fix.lon] : [c.lat, c.lng];
  const near = fix && loc ? loc : locateOnTrack(active.nav, from[0], from[1]);
  const [lat, lon] = near.latlng;
  // Arrow points from the screen centre toward the track.
  const deg = bearing(c.lat, c.lng, lat, lon);
  pill.querySelector('.arrow').style.transform = `rotate(${deg}deg)`;
  pill.querySelector('.txt').textContent = `Show track · ${fmtDist(near.offset)} away`;
  pill.hidden = false;
}
map.on('moveend zoomend', updateFindTrack);

// ---------- recording ----------
let recSaveTimer = null;
// Throttled (not debounced): a steady stream of GPS fixes must still get saved.
function saveRecSoon() {
  if (recSaveTimer) return;
  recSaveTimer = setTimeout(() => { recSaveTimer = null; db.set('recording', rec.toJSON()); }, 2000);
}
const saveRecNow = () => { clearTimeout(recSaveTimer); recSaveTimer = null; return db.set('recording', rec.toJSON()); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveRecNow(); });
window.addEventListener('pagehide', () => saveRecNow());

$('btn-main').addEventListener('click', async () => {
  if (rec.status === 'running') {
    rec.pause();
    toast('Recording paused. Tap ••• to finish and save it.');
  } else {
    rec.start();
    toast('Recording your hike');
    if (fix && Date.now() - lastFixAt < 10000) onFix(fix);
  }
  await saveRecNow();
  render();
  updateWakeLock();
});

$('btn-more').addEventListener('click', () => $('dlg-more').showModal());

$('btn-finish').addEventListener('click', async () => {
  $('dlg-more').close();
  if (rec.points.length < 2) { toast('Nothing recorded yet'); return; }
  rec.pause();
  const date = new Date(rec.startedAt || Date.now());
  const name = `Hike ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const stored = await addTrack({ name, points: rec.points.map((p) => [p[0], p[1], p[2]]), waypoints: [] }, 'recorded');
  stored.recordedPoints = rec.points;
  await db.putTrack(stored);
  await resetRecording();
  toast(`Saved "${name}" to your tracks`, 4000);
  renderTrackList();
});

$('btn-export-rec').addEventListener('click', () => {
  $('dlg-more').close();
  if (rec.points.length < 2) { toast('Nothing recorded yet'); return; }
  shareGpx(`Hike ${new Date(rec.startedAt).toISOString().slice(0, 10)}`, rec.points);
});

$('btn-discard').addEventListener('click', async () => {
  if (!(await ask('Discard recording?', 'Your recorded path, time and distance will be deleted.', 'Discard', 'Cancel'))) return;
  $('dlg-more').close();
  await resetRecording();
});

async function resetRecording() {
  rec = new Recorder();
  crumbLine.setLatLngs([]);
  await saveRecNow();
  render();
  updateWakeLock();
}

$('btn-sim').addEventListener('click', () => {
  $('dlg-more').close();
  if (simStop) { simStop(); simStop = null; toast('Simulation stopped'); $('btn-sim').textContent = 'Simulate a walk on the active track'; return; }
  if (!active) { toast('Pick a track first'); return; }
  setFollow(true);
  simStop = simulateWalk(active.nav, onFix, { speed: 12 });
  $('btn-sim').textContent = 'Stop simulation';
  toast('Simulating a walk at 10× speed. Press Start to record it.');
});

// ---------- rendering ----------
function setVal(id, [v, u]) { $(id).textContent = v; const uEl = $(`${id}-u`); if (uEl) uEl.textContent = u; }

function render() {
  const now = Date.now();
  const t = U.duration(rec.elapsed(now));
  $('s-time').textContent = t;
  $('d-time').textContent = t;
  setVal('s-dist', U.dist(rec.distance));
  setVal('d-dist', U.dist(rec.distance));
  setVal('d-gain', U.ele(rec.gain));
  setVal('d-pace', U.pace(rec.pace()));
  const spd = fix && now - lastFixAt < 15000 ? (fix.speed != null && fix.speed >= 0 ? fix.speed : 0) : 0;
  setVal('d-speed', U.speed(spd));

  if (active) setVal('d-rem', U.dist(active.nav.total - (progressAlong ?? 0)));
  else setVal('d-rem', ['—', '']);
  $('track-name').textContent = active ? active.stored.name : 'No track open';
  $('track-chip').textContent = active ? 'Change ›' : 'Open ›';

  const main = $('btn-main');
  main.classList.toggle('running', rec.status === 'running');
  main.classList.toggle('paused', rec.status === 'paused');
  main.setAttribute('aria-label', rec.status === 'running' ? 'Pause recording' : rec.status === 'paused' ? 'Resume recording' : 'Record hike');

  const off = $('offtrack');
  if (loc && loc.offset > OFF_TRACK_M) {
    off.hidden = false;
    off.textContent = `Off track · ${fmtDist(loc.offset)} away`;
  } else off.hidden = true;

  renderProfile();
}

function renderProfile() {
  const canvas = $('profile');
  if (active) {
    const nav = active.nav;
    profileX = drawProfile(canvas, nav.cum, nav.points.map((p) => p[2]), progressAlong, { scrub: scrubAlong });
  } else {
    const cum = [0];
    const pts = rec.points;
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + L.latLng(pts[i - 1]).distanceTo(pts[i]));
    profileX = drawProfile(canvas, cum, pts.map((p) => p[2]), cum[cum.length - 1], { empty: 'Elevation profile appears here' });
  }
}

// Scrub the profile to see where a climb is on the map.
const profileCanvas = $('profile');
let scrubAlong = null;
let scrubTimer = null;
function scrub(e) {
  if (!active || !profileX) return;
  clearTimeout(scrubTimer);
  const r = profileCanvas.getBoundingClientRect();
  scrubAlong = profileX.toAlong(e.clientX - r.left);
  const p = pointAt(active.nav, scrubAlong);
  scrubMarker.setLatLng([p.lat, p.lon]).addTo(map);
  renderProfile();
  const tip = $('profile-tip');
  tip.hidden = false;
  tip.textContent = `${fmtDist(scrubAlong)} · ${p.ele != null ? U.ele(p.ele).join(' ') : ''}`;
  // Keep the label above the finger, but inside the panel.
  const half = tip.offsetWidth / 2;
  const x = Math.min(Math.max(profileX.toX(scrubAlong), half), r.width - half);
  tip.style.left = `${x}px`;
}
profileCanvas.addEventListener('pointerdown', (e) => { profileCanvas.setPointerCapture(e.pointerId); scrub(e); });
profileCanvas.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') scrub(e); });
const endScrub = () => {
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => { scrubAlong = null; scrubMarker.remove(); $('profile-tip').hidden = true; renderProfile(); }, 1500);
};
profileCanvas.addEventListener('pointerup', endScrub);
profileCanvas.addEventListener('pointercancel', endScrub);

// ---------- sheet & dialogs ----------
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--sheet-h', `${sheetHeight()}px`);
}).observe($('sheet'));

$('sheet-toggle').addEventListener('click', () => { $('sheet').classList.toggle('collapsed'); setTimeout(renderProfile, 260); });
$('sheet-summary').addEventListener('click', () => { $('sheet').classList.remove('collapsed'); setTimeout(renderProfile, 260); });

document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

$('btn-tracks').addEventListener('click', openTracks);

$('btn-layers').addEventListener('click', async () => {
  $('layer-options').innerHTML = Object.entries(LAYERS).map(([k, l]) =>
    `<label class="radio"><input type="radio" name="layer" value="${k}" ${k === settings.layer ? 'checked' : ''}/> ${l.name}</label>`).join('');
  $('opt-dark').checked = settings.dark;
  $('opt-awake').checked = settings.keepAwake;
  document.querySelector(`input[name=units][value=${settings.units}]`).checked = true;
  $('dlg-layers').showModal();
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $('storage-info').textContent = est
    ? `Offline storage used: ${(est.usage / 1048576).toFixed(1)} MB${persisted ? ' (protected from cleanup)' : ''}`
    : '';
  const m = $('map');
  const c = map.getCenter();
  $('diag').textContent = [
    `Version ${__BUILD__}`,
    `Map ${m.clientWidth}×${m.clientHeight}, zoom ${map.getZoom()}, centre ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`,
    `Tiles on screen: ${document.querySelectorAll('.leaflet-tile-loaded').length} loaded / ${document.querySelectorAll('.leaflet-tile').length}`,
    `Tracks: ${tracks.size}, open: ${active ? active.stored.points.length + ' points' : 'none'}`,
    errorLog.length ? `Recent errors:\n${errorLog.join('\n')}` : 'No errors recorded',
  ].join('\n');
});

$('btn-reload').addEventListener('click', () => location.reload());

$('dlg-layers').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.name === 'layer') { settings.layer = t.value; setBaseLayer(); }
  if (t.id === 'opt-dark') { settings.dark = t.checked; setBaseLayer(); }
  if (t.id === 'opt-awake') { settings.keepAwake = t.checked; updateWakeLock(); }
  if (t.name === 'units') { settings.units = t.value; U.setMetric(t.value === 'metric'); setScale(); renderTrackList(); render(); }
  await db.set('settings', settings);
});

$('btn-clear-tiles').addEventListener('click', async () => {
  if (!(await ask('Delete all offline maps?', 'You will need signal to download them again.', 'Delete', 'Cancel'))) return;
  await clearTiles();
  for (const t of tracks.values()) if (t.offline) { t.offline = null; await db.putTrack(t); }
  setBaseLayer();
  $('dlg-layers').close();
  toast('Offline maps deleted');
});

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
$('toast').addEventListener('click', () => { $('toast').hidden = true; });

// ---------- screen wake lock ----------
let wakeLock = null;
async function updateWakeLock() {
  const want = settings.keepAwake && document.visibilityState === 'visible' && (rec.status === 'running' || !!active);
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed right now; we retry on the next tap */ }
  } else if (!want && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
// iOS can resume a home-screen app with a stale viewport size; re-measure the map.
const refreshMap = () => { map.invalidateSize(); updateFindTrack(); };
document.addEventListener('visibilitychange', () => {
  updateWakeLock();
  if (document.visibilityState === 'visible') { render(); refreshMap(); }
});
window.addEventListener('pageshow', refreshMap);
window.addEventListener('orientationchange', () => setTimeout(refreshMap, 300));
document.addEventListener('click', () => { if (!wakeLock) updateWakeLock(); });

// ---------- errors & safe mode ----------
const errorLog = (() => { try { return JSON.parse(localStorage.getItem('tg-errors') || '[]'); } catch { return []; } })();
function logError(msg) {
  errorLog.push(`${new Date().toLocaleString()}: ${msg}`);
  errorLog.splice(0, Math.max(0, errorLog.length - 8));
  try { localStorage.setItem('tg-errors', JSON.stringify(errorLog)); } catch { /* storage unavailable */ }
  toast(`Error: ${msg}`, 8000);
}
window.addEventListener('error', (e) => logError(e.message || String(e.error)));
window.addEventListener('unhandledrejection', (e) => logError(e.reason?.message || String(e.reason)));

// If the previous launch never finished starting up, start without opening a track.
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };
const safeMode = !!lsGet('tg-booting');

// ---------- boot ----------
async function boot() {
  lsSet('tg-booting', String(Date.now()));
  Object.assign(settings, (await db.get('settings')) || {});
  U.setMetric(settings.units === 'metric');
  setBaseLayer();
  setScale();

  for (const t of await db.tracks()) tracks.set(t.id, t);
  const savedRec = await db.get('recording');
  if (savedRec) {
    rec = new Recorder(savedRec);
    crumbLine.setLatLngs(rec.points.map((p) => [p[0], p[1]]));
  }
  const activeId = await db.get('activeTrackId');
  if (activeId && tracks.has(activeId) && !safeMode) await setActive(activeId);
  else { render(); renderTrackList(); }
  if (safeMode) toast('The app didn\'t start properly last time, so no track was opened. Your tracks are still in My tracks.', 8000);
  // Startup counts as successful once the app has stayed responsive for a few seconds.
  setTimeout(() => lsSet('tg-booting', null), 4000);

  setFollow(true);
  watchGps(onFix, onGpsError);
  setInterval(() => { render(); updateBadge(); }, 1000);
  window.addEventListener('resize', () => { renderProfile(); map.invalidateSize(); });

  if (!tracks.size) setTimeout(() => toast('Tap "My tracks" to import a GPX file', 5000), 800);

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot().catch((e) => { console.error(e); toast(`Startup error: ${e.message}`, 0); });
