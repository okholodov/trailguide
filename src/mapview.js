// Map engine: MapLibre GL draws tiles, track, walked path and position in one
// WebGL frame, so everything stays glued together while pinching and rotating.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LAYERS, registerTileProtocol, styleTileUrl } from './tiles.js';

const empty = { type: 'FeatureCollection', features: [] };
const line = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
const point = (lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} });

function circle(lon, lat, radiusM, n = 48) {
  const dLat = radiusM / 111132;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

// Dark map = inverted raster colours (done on the GPU, no CSS filters).
const rasterPaint = (dark) => (dark
  ? { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180, 'raster-saturation': -0.35, 'raster-contrast': -0.1 }
  : { 'raster-brightness-min': 0, 'raster-brightness-max': 1, 'raster-hue-rotate': 0, 'raster-saturation': 0, 'raster-contrast': 0 });

export function createMapView(container) {
  registerTileProtocol(maplibregl);

  const map = new maplibregl.Map({
    container,
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#2a2e33' } }] },
    center: [-98.6, 39.8],
    zoom: 3,
    maxZoom: 18,
    maxPitch: 0, // flat map; two fingers rotate + zoom, no tilt
    attributionControl: { compact: true },
    fadeDuration: 0,
  });
  map.touchPitch.disable();
  map.keyboard.disable();

  let scale = null;
  let baseKey = null;
  const markers = []; // start/finish/waypoint DOM markers

  const ready = new Promise((resolve) => map.on('load', () => {
    map.addSource('track', { type: 'geojson', data: empty });
    map.addSource('crumb', { type: 'geojson', data: empty });
    map.addSource('acc', { type: 'geojson', data: empty });
    map.addSource('scrub', { type: 'geojson', data: empty });
    map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#4b8dff', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#4b8dff', 'line-opacity': 0.5, 'line-width': 1 } });
    map.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0d2a12', 'line-opacity': 0.5, 'line-width': 9 } });
    map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#86e35b', 'line-width': 5 } });
    map.addLayer({ id: 'crumb-line', type: 'line', source: 'crumb', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2f9bf0', 'line-width': 5, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'scrub-dot', type: 'circle', source: 'scrub', paint: { 'circle-radius': 7, 'circle-color': '#ff9f1a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    resolve();
  }));
  // Missing tiles (e.g. outside USGS coverage) are expected; keep them out of the error log.
  map.on('error', () => {});

  // Position marker: rotationAlignment 'map' means its rotation is a compass heading.
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = '<div class="halo"></div><svg class="arrow" viewBox="0 0 40 40"><path d="M20 5 31 33 20 27 9 33z"/></svg><div class="dot"></div>';
  const me = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  let meShown = false;

  const view = {
    map,
    ready,

    async setBase(key, dark) {
      await ready;
      if (baseKey !== key) {
        if (map.getLayer('base')) map.removeLayer('base');
        if (map.getSource('base')) map.removeSource('base');
        const l = LAYERS[key];
        map.addSource('base', { type: 'raster', tiles: [styleTileUrl(key)], tileSize: 256, maxzoom: l.maxNativeZoom, attribution: l.attribution });
        map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: rasterPaint(dark) }, 'acc-fill');
        baseKey = key;
      } else {
        for (const [k, v] of Object.entries(rasterPaint(dark))) map.setPaintProperty('base', k, v);
      }
    },

    setScaleUnits(metric) {
      if (scale) map.removeControl(scale);
      scale = new maplibregl.ScaleControl({ maxWidth: 140, unit: metric ? 'metric' : 'imperial' });
      map.addControl(scale, 'top-left');
    },

    async setTrack(points, waypoints = []) {
      await ready;
      for (const m of markers.splice(0)) m.remove();
      if (!points) { map.getSource('track').setData(empty); return; }
      map.getSource('track').setData(line(points.map((p) => [p[1], p[0]])));
      const pin = (cls) => { const el = document.createElement('div'); el.className = `pin ${cls}`; return el; };
      const first = points[0], last = points[points.length - 1];
      const loop = Math.abs(first[0] - last[0]) < 0.0003 && Math.abs(first[1] - last[1]) < 0.0003;
      markers.push(new maplibregl.Marker({ element: pin('finish') }).setLngLat([last[1], last[0]]).addTo(map));
      markers.push(new maplibregl.Marker({ element: pin(loop ? 'start loop' : 'start') }).setLngLat([first[1], first[0]]).addTo(map));
      for (const w of waypoints) {
        const el = document.createElement('div');
        el.className = 'wpt';
        el.innerHTML = '<i></i><span></span>';
        el.querySelector('span').textContent = w.name;
        markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [-6, 0] }).setLngLat([w.lon, w.lat]).addTo(map));
      }
    },

    async setCrumb(points) {
      await ready;
      map.getSource('crumb').setData(points.length > 1 ? line(points.map((p) => [p[1], p[0]])) : empty);
    },

    setMe(fix) {
      if (!fix) return;
      me.setLngLat([fix.lon, fix.lat]);
      if (!meShown) { me.addTo(map); meShown = true; }
      map.getSource('acc')?.setData(fix.acc ? circle(fix.lon, fix.lat, fix.acc) : empty);
    },
    hasMe: () => meShown,

    /** Compass heading in degrees, or null for a plain dot. */
    setHeading(h) {
      meEl.classList.toggle('has-heading', h != null);
      if (h != null) me.setRotation(h);
    },

    setScrub(lat, lon) {
      map.getSource('scrub')?.setData(lat == null ? empty : point(lon, lat));
    },

    /** Space covered by the bottom panel etc., so "centre" means the visible part of the map. */
    setPadding(p) {
      const next = { top: 0, left: 0, right: 0, bottom: 0, ...p };
      const cur = map.getPadding();
      if (['top', 'bottom', 'left', 'right'].every((k) => Math.abs(cur[k] - next[k]) < 1)) return;
      // Changing padding is a camera move and would cancel a running fly/fit animation.
      if (map.isMoving()) map.once('moveend', () => view.setPadding(p));
      else map.setPadding(next);
    },

    centerOn(lat, lon, zoom = map.getZoom(), animate = true) {
      map.easeTo({ center: [lon, lat], zoom, duration: animate ? 400 : 0 });
    },

    /** bounds: [[minLat, minLon], [maxLat, maxLon]] */
    fitBounds(bounds) {
      map.fitBounds([[bounds[0][1], bounds[0][0]], [bounds[1][1], bounds[1][0]]], {
        padding: { top: 40, bottom: 30, left: 40, right: 40 }, bearing: map.getBearing(), duration: 500, maxZoom: 17,
      });
    },

    /** True if the track's bounding box overlaps what is on screen. */
    sees(bounds) {
      const v = map.getBounds();
      return !(bounds[1][0] < v.getSouth() || bounds[0][0] > v.getNorth() || bounds[1][1] < v.getWest() || bounds[0][1] > v.getEast());
    },

    getZoom: () => map.getZoom(),
    getCenter: () => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    getBearing: () => map.getBearing(),
    resetNorth: () => map.easeTo({ bearing: 0, duration: 300 }),
    resize: () => map.resize(),
    on: (ev, fn) => map.on(ev, fn),
  };
  return view;
}
