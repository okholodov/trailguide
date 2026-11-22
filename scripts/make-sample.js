// Generates a SYNTHETIC demo loop near Mount Tammany (Delaware Water Gap).
// The shape and elevations are approximate — for trying the app only, not for real navigation.
import { writeFileSync, mkdirSync } from 'node:fs';

const ctrl = [
  [40.9724, -75.1257], [40.9718, -75.1272], [40.9712, -75.129], [40.9716, -75.1305], [40.9709, -75.132],
  [40.9715, -75.1338], [40.9722, -75.1352], [40.9705, -75.1362], [40.9688, -75.1372], [40.9668, -75.1365],
  [40.9655, -75.135], [40.965, -75.133], [40.9655, -75.131], [40.966, -75.129], [40.967, -75.1272],
  [40.9685, -75.1262], [40.97, -75.1255], [40.9712, -75.125], [40.9724, -75.1257],
];
const ele = [90, 150, 230, 290, 350, 410, 440, 465, 440, 390, 330, 270, 220, 180, 150, 125, 110, 98, 90];

const pts = [];
for (let i = 0; i < ctrl.length - 1; i++) {
  const [a, b] = [ctrl[i], ctrl[i + 1]];
  const steps = 12;
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    const wig = Math.sin((i * steps + s) * 0.9) * 0.00004;
    pts.push([a[0] + (b[0] - a[0]) * t + wig, a[1] + (b[1] - a[1]) * t - wig, ele[i] + (ele[i + 1] - ele[i]) * t]);
  }
}
pts.push([...ctrl[ctrl.length - 1], ele[ele.length - 1]]);

const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailGuide sample" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>Sample loop (synthetic)</name></metadata>
<wpt lat="40.9722" lon="-75.1352"><name>Lookout</name></wpt>
<trk><name>Sample loop (synthetic)</name><trkseg>
${pts.map(([la, lo, e]) => `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"><ele>${e.toFixed(1)}</ele></trkpt>`).join('\n')}
</trkseg></trk>
</gpx>
`;
mkdirSync('public/samples', { recursive: true });
writeFileSync('public/samples/tammany-loop.gpx', gpx);
console.log(`sample written: ${pts.length} points`);
