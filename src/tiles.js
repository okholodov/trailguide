export const TILE_CACHE = 'tg-tiles';

export const LAYERS = {
  usgs: {
    name: 'USGS Topo (USA)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 16,
    offlineZooms: [8, 16],
    attribution: 'USGS The National Map',
  },
  otm: {
    name: 'OpenTopoMap (worldwide)',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 17,
    offlineZooms: [8, 15], // be gentle with a volunteer-run server
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  },
};

export const tileUrl = (layerKey, z, x, y) =>
  LAYERS[layerKey].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

let cacheP;
const tileCache = () => (cacheP ||= ('caches' in window ? caches.open(TILE_CACHE) : Promise.resolve(null)));

/**
 * The map asks for tiles as `tg://host/path`; we answer from the offline cache first
 * and only go to the network if the tile wasn't saved. This is what makes the map
 * work with no signal.
 */
export const styleTileUrl = (layerKey) => LAYERS[layerKey].url.replace('https://', 'tg://');

let protocolAdded = false;
export function registerTileProtocol(maplibregl) {
  if (protocolAdded) return;
  protocolAdded = true;
  maplibregl.addProtocol('tg', async (params, abortController) => {
    const url = `https://${params.url.slice('tg://'.length)}`;
    const cache = await tileCache().catch(() => null);
    const hit = cache && (await cache.match(url, { ignoreVary: true }));
    if (hit) return { data: await hit.arrayBuffer() };
    const res = await fetch(url, { signal: abortController.signal });
    if (!res.ok) throw new Error(`Tile ${res.status}`);
    return { data: await res.arrayBuffer() };
  });
}

const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const lat2y = (lat, n) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

/** Tiles covering a corridor of `bufferM` metres around the track at each zoom. */
export function tilesForTrack(points, layerKey, bufferM = 700) {
  const [z0, z1] = LAYERS[layerKey].offlineZooms;
  const set = new Set();
  for (let z = z0; z <= z1; z++) {
    const n = 2 ** z;
    let last = null;
    for (const [lat, lon] of points) {
      const x = lon2x(lon, n), y = lat2y(lat, n);
      const tileM = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / n;
      const b = bufferM / tileM;
      // Skip points that are a tiny fraction of a tile from the last one.
      if (last && Math.abs(x - last[0]) < 0.1 && Math.abs(y - last[1]) < 0.1) continue;
      last = [x, y];
      for (let tx = Math.floor(x - b); tx <= Math.floor(x + b); tx++) {
        for (let ty = Math.floor(y - b); ty <= Math.floor(y + b); ty++) {
          if (tx >= 0 && ty >= 0 && tx < n && ty < n) set.add(`${z}/${tx}/${ty}`);
        }
      }
    }
  }
  return [...set];
}

/** Download tiles into the cache. Returns { saved, skipped, failed, bytes }. */
export async function downloadTiles(layerKey, keys, onProgress, signal) {
  const cache = await tileCache();
  if (!cache) throw new Error('This browser cannot store offline maps.');
  const stats = { saved: 0, skipped: 0, failed: 0, bytes: 0, done: 0, total: keys.length };
  let next = 0;
  const worker = async () => {
    while (next < keys.length && !signal?.aborted) {
      const [z, x, y] = keys[next++].split('/');
      const url = tileUrl(layerKey, z, x, y);
      try {
        if (await cache.match(url, { ignoreVary: true })) stats.skipped++;
        else {
          let res;
          for (let attempt = 0; attempt < 3; attempt++) {
            res = await fetch(url, { mode: 'cors', signal });
            if (res.ok || res.status === 404) break;
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
          if (res.ok) {
            const blob = await res.blob();
            await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } }));
            stats.saved++;
            stats.bytes += blob.size;
          } else stats.failed++;
        }
      } catch (e) {
        if (signal?.aborted) break;
        stats.failed++;
      }
      stats.done++;
      onProgress?.(stats);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return stats;
}

export async function clearTiles() {
  cacheP = null;
  if ('caches' in window) await caches.delete(TILE_CACHE);
}
