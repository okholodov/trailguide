import { haversine, GainCounter } from './geo.js';

/** Records your hike: time, distance, elevation gain and the breadcrumb trail. */
export class Recorder {
  constructor(saved = {}) {
    this.status = saved.status || 'idle'; // idle | running | paused
    this.accMs = saved.accMs || 0;
    this.resumedAt = saved.resumedAt || null;
    this.startedAt = saved.startedAt || null;
    this.points = saved.points || []; // [lat, lon, ele, t]
    this.distance = saved.distance || 0;
    this.movingMs = saved.movingMs || 0;
    this.gainCounter = new GainCounter(3, saved.gain);
  }

  get gain() { return this.gainCounter.gain; }

  elapsed(now = Date.now()) {
    return this.accMs + (this.status === 'running' && this.resumedAt ? now - this.resumedAt : 0);
  }

  start() {
    const now = Date.now();
    if (this.status === 'idle') { this.startedAt = now; }
    this.status = 'running';
    this.resumedAt = now;
  }

  pause() {
    if (this.status !== 'running') return;
    this.accMs = this.elapsed();
    this.resumedAt = null;
    this.status = 'paused';
  }

  /** Returns true if the fix was added to the breadcrumb. `ele` may come from the planned track. */
  add(fix, ele) {
    if (this.status !== 'running' || fix.acc > 50) return false;
    const last = this.points[this.points.length - 1];
    if (last) {
      const d = haversine(last[0], last[1], fix.lat, fix.lon);
      if (d < Math.max(4, fix.acc * 0.5)) return false;
      const dt = fix.t - last[3];
      if (dt > 0 && dt < 120000 && d / (dt / 1000) > 0.25) this.movingMs += dt;
      this.distance += d;
    }
    this.points.push([fix.lat, fix.lon, ele ?? null, fix.t]);
    this.gainCounter.push(ele);
    return true;
  }

  /** Average moving pace in seconds per metre. */
  pace() { return this.distance > 20 ? this.movingMs / 1000 / this.distance : NaN; }

  toJSON() {
    return {
      status: this.status, accMs: this.accMs, resumedAt: this.resumedAt, startedAt: this.startedAt,
      points: this.points, distance: this.distance, movingMs: this.movingMs, gain: this.gainCounter.toJSON(),
    };
  }
}
