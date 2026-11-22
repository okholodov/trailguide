# TrailGuide

Offline GPX trail navigation for iPhone, built as a web app (PWA) — no App Store, no developer account.

- Import `.gpx` tracks (AllTrails, CalTopo, Gaia, Strava exports…)
- Topo map with your track, live GPS position and compass heading
- Saves map tiles along each track so the map works with no signal
- Stats: time, distance, elevation gain, distance remaining, pace, speed
- Elevation profile with your position; drag on it to find a spot on the map
- Off-track warning (more than ~165 ft / 50 m from the line)
- Records your hike, survives app restarts, exports as GPX

## Develop

```powershell
npm install
npm run dev      # http://localhost:5173 (no service worker in dev)
npm run build    # production build in dist/
npm run preview  # serve dist/ at http://localhost:4173 (offline mode works here)
```

Try it without walking: Tracks → **Load sample track**, then ••• → **Simulate a walk** and press **Start**.
The sample track is synthetic, so don't use it for real navigation.

## Put it on your iPhone

GPS in the browser only works over HTTPS, so the app needs to be hosted. Free options:

- **GitHub Pages**: push this folder to a GitHub repo, then go to Settings → Pages → Source: **GitHub Actions**. The included workflow (`.github/workflows/deploy.yml`) builds and publishes on every push to `main`.
- **Netlify Drop**: run `npm run build`, then drag the `dist` folder onto https://app.netlify.com/drop.

Then on the iPhone:
1. Open the URL in **Safari** → Share → **Add to Home Screen**.
2. Open TrailGuide from the home screen and allow location **While Using**.
3. Import your GPX (from Files) and tap **Save map** while you still have signal.
4. Before the hike, put the phone in airplane mode and open the app to confirm the map shows.

## Limits of a web app on iOS

- GPS stops while the screen is locked. With "Keep screen on" enabled, the screen stays awake while navigating.
  If you lock the phone anyway, your position updates when you unlock. The recorded path then draws a straight line across the gap.
- The compass needs one tap on the compass button to grant permission (an iOS rule).
- Offline maps use the USGS Topo map (public domain, US only) for zoom levels 8–16.
  OpenTopoMap covers the rest of the world, but only zoom levels 8–15 are saved, to go easy on its free servers.
