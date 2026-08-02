# Apex Lap Tracker

Apex is a zero-dependency, client-side motorcycle track-day instrument designed for a bar-mounted iPhone. The current app provides the forced-landscape shell, the Enable Sensors → Calibrate → Ready → Race flow, live speed and fused lean instruments, monotonic tap-to-lap timing, full-session sample capture, race wake lock, and a raw sensor simulator/record/replay harness. Reports and offline installation remain separate later issues.

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

- `?dev-sensors=simulator` replaces hardware with a deterministic 38-second session. It begins with a stable calibration interval, then includes low-speed (under 15 mph) manoeuvring, physically matched constant-radius corners in both directions, an 85-to-12 mph upright braking event, and gradual acceleration/finish sections. Its source readings include gravity, normalized three-axis body gyro rate, and orientation alongside GPS. Add `&dev-rate=4` to replay four times faster.
- `?dev-sensors=replay&replay-log=./path/to/raw-log.json` loads an exported raw JSON log and emits its readings through the same `requestAccess()` / `subscribe()` / `destroy()` source seam. `dev-rate` changes only delivery speed; sample values and timestamps are unchanged.
- `?dev-recorder=1` keeps real hardware selected, records every timestamped reading directly at the source seam during Race, and exports the in-memory JSON log when **END RACE** is tapped.

Recording uses RAM only. Export uses the Web Share API or an in-memory Blob download and never writes to localStorage, IndexedDB, or another application store. The log loader accepts JSON text, `Blob`/`File`, or a parsed log object.

## Lean estimation

`ZERO NOW` enables only after a recent stable window contains valid gravity and three-axis gyro readings; the accepted gravity vectors are averaged into an orthonormal bike frame. The configured mount assumption (device +Y, the phone's long axis) is usable immediately. Background refinement buffers motion between GPS receptions and accepts it only when the following accurate fix proves that completed interval was fast, straight, and accelerating. It requires at least three separately bracketed intervals with materially different acceleration, fits the changing device-acceleration slope against GPS longitudinal acceleration, and applies strict fit-quality, GPS-course, independent vertical-gyro, and device/GPS agreement gates. This separates a stable additive lateral/cross-axis acceleration intercept from mount yaw. Signed device components are retained through the fit and an inverted sensor convention is oriented only once from the final slope. Confidence is retained and revalidated; every contradictory valid interval reduces it and repeated contradictions smoothly roll a correction back. Low speed, shallow turns, braking, poor accuracy, stale/reordered fixes, inconsistent course, and noisy or implausible corrections cannot refine it. There is no rider step or refinement status in the UI. A lateral force exactly proportional to longitudinal acceleration remains physically unobservable with these two references because it changes the fitted slope exactly like mount yaw; the conservative straightness and fit gates reduce, but cannot eliminate, that residual ambiguity.

At the browser seam, `DeviceMotionEvent.rotationRate` is normalized from `alpha/beta/gamma` to explicit device `x/y/z`. The pure-math estimator integrates body roll for tip-in response, recovers world yaw from the physically rotated leaned body-rate vector, and complements it with the drift-free `atan(speed × yawRate / g)` anchor using the same platform-or-derived speed as the speedometer. Refinement uses a separate unsmoothed validated speed while the instrument and kinematic anchor retain their prior smoothing. GPS trust rejects reordered timestamps and expires by monotonic reception age without comparing GPS epoch time to `performance.now()`. The estimator remains gyro-only through GPS gaps, learns changing stationary gyro bias as a device-frame three-vector, slowly returns verified stationary lean to upright, and clamps signed output to ±60°. A missing or stalled gyro renders lean `N/A`; estimation still runs at sensor cadence while instrument DOM writes are capped at 5 Hz.

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

The shell models six mutually exclusive states: Enable, Calibrate, Ready, Race, Report, and Permission Denied. Browser sensor permissions, degraded access, and the unified raw sensor source are implemented. Ready renders smoothed live GPS speed in MPH, and Ready and Race render the same fused lean and speed sources. Race records timestamped position/speed/lean instrument samples at up to 20 Hz while retaining accepted native GPS fixes between instrument ticks; duplicate GPS bursts are coalesced. It marks laps from full-screen taps, keeps the display awake, and hands the completed timing and samples to the minimal Report transition. Detailed report UI behavior belongs to issue #8.
