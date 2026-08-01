# Apex Lap Tracker

Apex is a zero-dependency, client-side motorcycle track-day instrument designed for a bar-mounted iPhone. This first slice provides the forced-landscape application shell and the Enable Sensors → Calibrate entry flow. Sensor readings, timing, reports, offline installation, and persistence/export are intentionally reserved for later issues.

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
- Tap **ENABLE SENSORS**, then **ZERO NOW**. This issue only verifies routing; no permission request or sensor capture is implemented yet.

## Deployment-safe paths

All repository-owned assets use document-relative paths (`./css/...`, `./js/...`). Keep future assets and service-worker registration relative as well: GitHub Pages serves this project below `/TrackMaster/`, not at the domain root.

## Current scope

The shell models six mutually exclusive states: Enable, Calibrate, Ready, Race, Report, and Permission Denied. Permission Denied is a recovery placeholder for the later sensor-permissions issue and is not part of the normal path yet. Ready, Race, and Report contain only the minimum controls needed to prove routing; their live instruments and session behavior belong to later issues.
