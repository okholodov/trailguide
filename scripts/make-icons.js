// Renders the app icon to PNG with no dependencies (supersampled, zlib-compressed).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function png(size, shade) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const SS = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [cr, cg, cb] = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += cr; g += cg; b += cb;
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r / SS / SS; raw[o + 1] = g / SS / SS; raw[o + 2] = b / SS / SS;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

function shade(u, v) {
  // background: dark slate with subtle vertical gradient
  let c = [22 + 10 * v, 28 + 12 * v, 34 + 10 * v];
  // mountains
  if (inTri(u, v, [0.12, 0.78], [0.42, 0.3], [0.72, 0.78])) c = [70, 78, 88];
  if (inTri(u, v, [0.4, 0.78], [0.64, 0.4], [0.9, 0.78])) c = [95, 104, 116];
  if (inTri(u, v, [0.35, 0.41], [0.42, 0.3], [0.49, 0.41])) c = [235, 238, 242];
  // green trail: a sine path across the bottom
  const ty = 0.7 - 0.08 * Math.sin(u * Math.PI * 2.2) - 0.25 * u * 0.4;
  if (u > 0.14 && u < 0.86 && Math.abs(v - ty) < 0.028) c = [134, 227, 91];
  // blue position dot
  const dx = u - 0.74, dy = v - (0.7 - 0.08 * Math.sin(0.74 * Math.PI * 2.2) - 0.25 * 0.74 * 0.4);
  const d = Math.hypot(dx, dy);
  if (d < 0.075) c = [255, 255, 255];
  if (d < 0.055) c = [75, 141, 255];
  return c;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, shade));
writeFileSync('public/icons/icon-512.png', png(512, shade));
writeFileSync('public/icons/apple-touch-icon.png', png(180, shade));
console.log('icons written');
