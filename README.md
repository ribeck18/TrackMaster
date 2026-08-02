# Apex Lap Tracker

Apex is a zero-dependency, client-side motorcycle track-day instrument designed for a bar-mounted iPhone. The current app provides the forced-landscape shell, the Enable Sensors → Calibrate flow, and a raw sensor simulator/record/replay harness. Estimation, timing, reports, and offline installation remain separate later issues.

## Run locally

No packages or build step are required. Serve the repository root with any static HTTP server; for example:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Run the routing tests with:

```sh
npm test
```

> Local HTTP is useful for layout work only. iPhone motion and location APIs require a secure HTTPS deployment.

## Developer sensor harness

The normal rider flow always uses the browser motion and location source. Developer sources are selected only by URL parameters; there is no in-app control or route to them.

- `?dev-sensors=simulator` replaces hardware with a deterministic 38-second session. It includes low-speed (under 15 mph) manoeuvring, sustained constant-radius corners in both directions, an 85-to-12 mph upright braking event, and physically gradual acceleration/finish sections. Add `&dev-rate=4` to replay four times faster.
- `?dev-sensors=replay&replay-log=./path/to/raw-log.json` loads an exported raw JSON log and emits its readings through the same `requestAccess()` / `subscribe()` / `destroy()` source seam. `dev-rate` changes only delivery speed; sample values and timestamps are unchanged.
- `?dev-recorder=1` keeps real hardware selected, records every timestamped reading directly at the source seam during Race, and exports the in-memory JSON log when **END RACE** is tapped.

Recording uses RAM only. Export uses the Web Share API or an in-memory Blob download and never writes to localStorage, IndexedDB, or another application store. The log loader accepts JSON text, `Blob`/`File`, or a parsed log object.

## Deploy with GitHub Pages

GitHub Pages provides the HTTPS origin required by iPhone sensor permissions.

1. Push these files to the branch that should be published (normally the repository's default branch).
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the published branch and **`/(root)`**, then choose **Save**.
5. Wait for the Pages deployment to finish. GitHub shows the public URL on the same settings page. For this repository it is expected to be `https://ribeck18.github.io/TrackMaster/`.
6. Open that HTTPS URL in Safari on the iPhone. The first screen should read **ENABLE SENSORS**.

Pages is repository configuration and cannot be enabled by application code. Public repositories can use Pages on GitHub Free; private-repository availability depends on the account plan.

### iPhone shell check

- Open the Pages URL in portrait. The app should rotate its own canvas into a usable landscape layout even if iOS Rotation Lock is enabled.
- Confirm that the Rotation Lock hint is visible but does not block the button.
- Turn the phone physically landscape. The app should use native landscape without the hint.
- Confirm that content stays clear of the notch/Dynamic Island on either landscape edge.
- Tap **ENABLE SENSORS**, grant or decline each permission, and confirm the live spirit level or documented degraded state before tapping **ZERO NOW**.

## Deployment-safe paths

All repository-owned assets use document-relative paths (`./css/...`, `./js/...`). Keep future assets and service-worker registration relative as well: GitHub Pages serves this project below `/TrackMaster/`, not at the domain root.

## Current scope

The shell models six mutually exclusive states: Enable, Calibrate, Ready, Race, Report, and Permission Denied. Browser sensor permissions, degraded access, and the unified raw sensor source are implemented. Ready renders smoothed live GPS speed in MPH, no-fix recovery, and the exact parked lean gauge. Race and Report retain only the minimum controls needed to prove routing; live lean estimation, lap timing, and report UI behavior belong to later issues.
