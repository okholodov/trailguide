import { profileScale } from './units.js';

/**
 * Elevation profile like the screenshot: done part filled brown, white outline,
 * blue dot at the current position. `cum` = distance (m), `eles` = elevation (m).
 */
export function drawProfile(canvas, cum, eles, along, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const sc = profileScale();
  const valid = [];
  for (let i = 0; i < cum.length; i++) if (eles[i] != null) valid.push(i);
  ctx.fillStyle = '#8a9099';
  ctx.font = '12px -apple-system, system-ui, sans-serif';
  if (valid.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText(opts.empty || 'No elevation data', w / 2, h / 2);
    return null;
  }

  const total = cum[cum.length - 1] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const i of valid) { lo = Math.min(lo, eles[i]); hi = Math.max(hi, eles[i]); }
  if (hi - lo < 10) { hi += 5; lo -= 5; }

  const padL = 4, padR = 62, padT = 10, padB = 20;
  const pw = w - padL - padR, ph = h - padT - padB;
  const X = (d) => padL + (d / total) * pw;
  const Y = (e) => padT + (1 - (e - lo) / (hi - lo)) * ph;
  const base = padT + ph;

  // Filled "done" area.
  if (along != null && along > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, X(Math.min(along, total)), h);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(X(cum[valid[0]]), base);
    for (const i of valid) ctx.lineTo(X(cum[i]), Y(eles[i]));
    ctx.lineTo(X(cum[valid[valid.length - 1]]), base);
    ctx.closePath();
    ctx.fillStyle = '#6e3322';
    ctx.fill();
    ctx.restore();
  }

  ctx.beginPath();
  valid.forEach((i, k) => (k ? ctx.lineTo(X(cum[i]), Y(eles[i])) : ctx.moveTo(X(cum[i]), Y(eles[i]))));
  ctx.strokeStyle = '#f2f2f2';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Axis
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, base + 0.5); ctx.lineTo(padL + pw, base + 0.5); ctx.stroke();

  ctx.fillStyle = '#d6d9de';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(hi * sc.e).toLocaleString()} ${sc.eu}`, w - 2, padT + 10);
  ctx.fillText(`${Math.round(lo * sc.e).toLocaleString()} ${sc.eu}`, w - 2, base - 4);
  ctx.textAlign = 'left';
  ctx.fillText(`0 ${sc.du}`, padL, h - 4);
  ctx.textAlign = 'center';
  ctx.fillText(`${(total / 2 / sc.d).toFixed(1)} ${sc.du}`, X(total / 2), h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${(total / sc.d).toFixed(1)} ${sc.du}`, padL + pw, h - 4);

  const eleAt = (a) => {
    let k = 0;
    while (k < valid.length - 2 && cum[valid[k + 1]] < a) k++;
    const i0 = valid[k], i1 = valid[k + 1];
    const t = cum[i1] > cum[i0] ? Math.min(1, Math.max(0, (a - cum[i0]) / (cum[i1] - cum[i0]))) : 0;
    return eles[i0] + t * (eles[i1] - eles[i0]);
  };
  const dot = (a, color) => {
    ctx.beginPath();
    ctx.arc(X(a), Y(eleAt(a)), 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  };

  // Current position dot.
  if (along != null) dot(Math.min(Math.max(along, 0), total), '#4b8dff');

  // Point being inspected with a finger: guide line + orange dot (matches the map marker).
  if (opts.scrub != null) {
    const s = Math.min(Math.max(opts.scrub, 0), total);
    ctx.strokeStyle = 'rgba(255, 159, 26, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(s), padT); ctx.lineTo(X(s), base); ctx.stroke();
    dot(s, '#ff9f1a');
  }

  // Map a pointer x back to a distance (used for scrubbing).
  return { toAlong: (px) => Math.min(total, Math.max(0, ((px - padL) / pw) * total)), toX: X };
}
