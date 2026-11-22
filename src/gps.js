import { pointAt } from './geo.js';

const toFix = (p) => ({
  lat: p.coords.latitude,
  lon: p.coords.longitude,
  acc: p.coords.accuracy,
  alt: p.coords.altitude,
  altAcc: p.coords.altitudeAccuracy,
  speed: p.coords.speed,
  heading: p.coords.heading,
  t: p.timestamp || Date.now(),
});

export function watchGps(onFix, onError) {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('This device has no GPS access.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition((p) => onFix(toFix(p)), onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 60000,
  });
  return () => navigator.geolocation.clearWatch(id);
}

/** Compass heading in degrees (0 = north). iOS needs a tap to grant permission. */
export async function watchCompass(onHeading) {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) throw new Error('No compass on this device.');
  if (typeof DOE.requestPermission === 'function') {
    const r = await DOE.requestPermission();
    if (r !== 'granted') throw new Error('Compass permission was denied.');
  }
  const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  const handler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
    onHeading((h + screenAngle + 360) % 360);
  };
  window.addEventListener(evt, handler);
  return () => window.removeEventListener(evt, handler);
}

/** Fake GPS that walks along a track — for trying the app at home. */
export function simulateWalk(track, onFix, { speed = 12, startAlong = 0 } = {}) {
  let along = startAlong;
  const tick = () => {
    along = Math.min(track.total, along + speed);
    const p = pointAt(track, along);
    const jitter = () => (Math.random() - 0.5) * 0.00006;
    onFix({
      lat: p.lat + jitter(), lon: p.lon + jitter(), acc: 5 + Math.random() * 3,
      alt: p.ele != null ? p.ele + (Math.random() - 0.5) * 4 : null, altAcc: 8,
      speed: 1.4, heading: p.bearing, t: Date.now(), simulated: true,
    });
    if (along >= track.total) stop();
  };
  const id = setInterval(tick, 1000);
  tick();
  const stop = () => clearInterval(id);
  return stop;
}
