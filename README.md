# Apex Lap Tracker

Apex is a zero-dependency, client-side motorcycle track-day instrument for a bar-mounted iPhone. It provides the Enable Sensors → Calibrate → Ready → Race → Report flow, live GPS speed and fused lean instruments, tap-to-lap timing and trim, an offline track map, and stateless JSON/GPX export. Ready renders smoothed live GPS speed in MPH and the shared fused lean gauge before a race begins. All run state stays in memory; the app does not use localStorage, IndexedDB, a database, or a server.

## Run locally

No packages or build step are required. Serve the repository root with any static HTTP server:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000/> and run the tests with:

```sh
npm test
```

Localhost is useful for layout, simulator, and replay work. Real iPhone motion and location permissions require the production HTTPS deployment.

## Offline PWA behavior

`manifest.webmanifest`, the iOS metadata, and the local icons make Apex launch from the iOS Home Screen in standalone mode. The service worker is registered with document-relative URL and scope, so the same files work at GitHub Pages' `/TrackMaster/` repository subpath.

A successful service-worker install atomically precaches the HTML, manifest, CSS, every application module, all icons, and locally hosted Rajdhani/Space Mono font files. Navigation and known assets are then served cache-first. Unlisted files, including temporary replay logs, are network-only and are never added to the cache. Run data is never cached or persisted.

The cache name contains the deployment stamp in `sw.js`. For every deployment that changes a precached file, update `BUILD_STAMP`. On an online launch the registration bypasses the HTTP cache and checks `sw.js`; the new worker must cache its complete shell before it activates. Activation removes older Apex caches and claims clients. A failed update leaves the prior complete build active, while a successful update is used on the next launch without clearing site data.

## Deploy with GitHub Pages

GitHub Pages provides the HTTPS origin required by iPhone sensor permissions.

1. Push the repository to the branch that should be published (normally the default branch).
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**.
4. Select the published branch and **`/(root)`**, then select **Save**.
5. Wait for the Pages deployment to report success. GitHub displays the public URL on the same page.
6. Open `https://ribeck18.github.io/TrackMaster/` (including the case-sensitive repository path) in iPhone Safari. Confirm the first screen reads **ENABLE SENSORS**.

Pages is repository configuration: application code and local tests cannot enable it, confirm the selected branch, or prove a deployment is live. A repository administrator must perform and verify these steps. Public repositories support Pages on GitHub Free; private-repository availability depends on the account plan.

All repository-owned runtime URLs must remain relative (`./...` or CSS-relative). Never change them to root-absolute `/...` paths; those would escape `/TrackMaster/` on Pages.

## Install on an iPhone Home Screen

Do this on reliable Wi-Fi or cellular service before travelling to the circuit:

1. In **Safari** (not an in-app browser), open the exact Pages URL above and let it finish loading.
2. Reload once while still online. This gives the newly installed service worker control of the page.
3. Tap **Share → Add to Home Screen → Add**.
4. Launch **Apex** from its Home Screen icon once while still online. It should fill the screen without Safari's address or toolbar chrome.
5. Grant sensors and complete the offline verification below before relying on it at a track.

Keep the Home Screen app installed. When a new version is deployed, launch it once while online to let the update download; no cache clearing or reinstall is required.

## Sensor permissions and recovery

Tap **ENABLE SENSORS** once and respond to both iOS prompts. Enable **Precise Location** for the best GPS readings. GPS receives a satellite radio fix and does not require cellular data, but the page must already be installed and cached.

Apex degrades rather than dead-ending: without motion, lean shows `N/A`; without a valid location fix, speed shows `--` and `GPS · NO FIX`; with a valid stationary fix, speed shows `0`. Lap timing and report/export remain available.

If a permission was denied, the web page usually cannot show the prompt again:

- **Motion:** open **Settings → Apps → Safari → Motion & Orientation Access** (or **Settings → Safari** on older iOS), enable it, fully close Apex, and reopen it.
- **Location:** open **Settings → Privacy & Security → Location Services → Safari Websites** (or the Apex Home Screen app when listed), choose **While Using**, and enable **Precise Location**. Then fully close and reopen Apex.
- If the relevant setting is still stuck, reconnect to the internet, remove the Home Screen icon, remove the `ribeck18.github.io` entry under **Settings → Safari → Advanced → Website Data**, revisit the Pages URL, grant access, and install again. Removing website data is a last-resort permission recovery step, not an update procedure.

Permission labels vary slightly by iOS release. The denied-state screen repeats the in-app recovery direction and always permits continuing with available sensors.

## Race keep-awake status

Screen Wake Lock requires **iOS/iPadOS 16.4 or later** in Safari or the installed Apex web app; this is Apex's minimum supported iOS version for automatic keep-awake during Race. Race shows **KEEP AWAKE ON** only while it holds a screen-wake-lock sentinel. **KEEP AWAKE UNSUPPORTED** means the browser does not expose the API, while **KEEP AWAKE OFF · REQUEST REJECTED** means a request was rejected and no lock is held. Both are non-fatal to lap timing, but neither is a claim that the display will stay on.

On a supported iOS/iPadOS version, use this manual fallback when either warning appears: keep Apex in the foreground and set **Settings → Display & Brightness → Auto-Lock → Never** for the session, then restore the prior Auto-Lock setting afterward. A visibility restoration or platform sentinel release automatically retries the API request; keep the warning visible until it changes to **KEEP AWAKE ON**.

Physical-device wake-lock validation is a release check, not something automated tests can fake: on a supported iPhone or iPad, start Race, verify **KEEP AWAKE ON**, background and restore Apex, and verify it returns to **ON**. Also exercise an unsupported or rejected condition and verify the matching warning and manual fallback guidance before release.

## Prove cold offline operation before the track

This physical-iPhone check is required; desktop tests cannot substitute for it.

1. Install and open Apex online, grant both permissions, and reach **Calibrate**.
2. Fully close the Home Screen app (remove it from the app switcher).
3. Enable **Airplane Mode**, then separately confirm both Wi-Fi and cellular data are off.
4. Launch Apex from the Home Screen icon. A cold launch must reach **ENABLE SENSORS** without an error page.
5. Complete a short end-to-end run: enable sensors, hold the phone stable and **ZERO NOW**, tap to start, record at least one lap tap, **END RACE**, inspect the report, and **SAVE RUN**.
6. Save/share the JSON/GPX to an offline-capable target such as **On My iPhone** in Files. A cloud-only destination may wait for connectivity.
7. Fully close and cold-launch Apex offline a second time. Repeat after every deployment used for a track day.

Airplane Mode can affect Assisted GPS time-to-first-fix, so `GPS · NO FIX` may remain longer outdoors even though satellite GPS itself works without data. Run this check outdoors as well as indoors.

## Developer sensor harness

Developer sources are selected only by URL parameters; there is no rider-facing switch and no application persistence.

- `?dev-sensors=simulator` replaces hardware with a deterministic 38-second session. It begins with a stable calibration interval, then includes low-speed (under 15 mph) manoeuvring, physically matched constant-radius corners in both directions, an 85-to-12 mph upright braking event, and gradual acceleration/finish sections. Its source readings include gravity, normalized three-axis body gyro rate, and orientation alongside GPS. Add `&dev-rate=4` to deliver it four times faster.
- `?dev-sensors=replay&replay-log=./trackmaster-raw-sensors.json` fetches a raw log and replays its untouched values and timestamps. Current v2 logs also restore the explicit initialization action—recorded calibration or continue without lean—and untouched pre/post-action readings before Race sample 1 is released. `dev-rate` changes delivery timing only.
- `?dev-recorder=1` keeps real hardware selected, emits a v2 log with the accepted calibration or explicit continue-without-lean action, captures untouched access-to-Race initialization readings, and records untouched source readings during Race. **END RACE** exports the in-memory raw JSON log automatically. If that export is cancelled or fails, Report retains the exact stopped log in RAM, shows its status, and offers **RETRY RAW LOG**.

`dev-recorder=1` is real-hardware-only and must not be combined with `dev-sensors=simulator` or `dev-sensors=replay`; Apex rejects those ambiguous URLs. Simulator and replay remain standalone source modes. The loader retains legacy v1 play-on-access behavior, while every newly recorded v2 log requires initialization/action metadata and uses gated playback.

Recording uses RAM only. Export uses the Web Share API or an in-memory Blob download and never writes to localStorage, IndexedDB, or another application store. The log loader accepts JSON text, `Blob`/`File`, or a parsed log object.

### Capture and export a first-track recorder log

1. Before leaving coverage, open `https://ribeck18.github.io/TrackMaster/?dev-recorder=1` in Safari and keep that tab available. Confirm the URL still contains `dev-recorder=1`; the normal Home Screen launch does not enable recording.
2. At the track, mount the phone rigidly, open that recorder URL, grant sensors, calibrate while fully upright and stationary, and begin the session.
3. After stopping safely, tap **END RACE**. In the automatic share sheet save `trackmaster-raw-sensors.json` to **On My iPhone**, AirDrop it, or choose another destination known to work offline. If the share is cancelled or fails, Report retains that exact stopped log in RAM and offers **RETRY RAW LOG**. Starting a replacement run or navigating away warns before discarding a retained raw log.
4. Back on the report, tap **SAVE RUN** separately to export the processed run JSON and GPX. These are not substitutes for the untouched raw recorder log.
5. Keep the raw log together with the circuit/layout, session time, weather, tire notes, mount orientation, and any transponder/video reference. Do not edit the log before replay.

### Replay the captured log at a desk

1. Copy the exported raw file temporarily to the served repository root as `trackmaster-raw-sensors.json`; do not commit it.
2. Start `python3 -m http.server 8000`.
3. Open `http://localhost:8000/?dev-sensors=replay&replay-log=./trackmaster-raw-sensors.json&dev-rate=1`. Use another positive `dev-rate` to scale both recorded initialization and Race delivery timing.
4. Tap **ENABLE SENSORS**, then perform the action shown: **LOAD RECORDED ZERO** for a calibrated run or **CONTINUE WITHOUT LEAN** for a degraded run. On Ready, tap to start Race. Apex first rebuilds the recorded post-action estimator state, then releases Race sample 1; no Race samples run ahead while the UI is on Enable, Calibrate, or Ready.
5. Let the replay finish, end the race, and compare live/report behavior with the saved report, video, or transponder reference. Replay uses the same source seam, GPS speed processing, and lean-estimator pipeline as hardware.
6. Delete the temporary log when finished. The service worker intentionally does not runtime-cache replay files.

## Lean estimation

Tapping `ZERO NOW` starts a roughly one-second capture: hold the bike upright and still while valid gravity and three-axis gyro readings are collected. The accepted gravity vectors are averaged into an orthonormal bike frame. The configured mount assumption (device +Y, the phone's long axis) is usable immediately. Background refinement buffers motion between GPS receptions and accepts it only when the following accurate fix proves that completed interval was fast, straight, and accelerating. It requires at least three separately bracketed intervals with materially different acceleration, fits the changing device-acceleration slope against GPS longitudinal acceleration, and applies strict fit-quality, GPS-course, independent vertical-gyro, and device/GPS agreement gates. This separates a stable additive lateral/cross-axis acceleration intercept from mount yaw. Signed device components are retained through the fit and an inverted sensor convention is oriented only once from the final slope. Confidence is retained and revalidated; every contradictory valid interval reduces it and repeated contradictions smoothly roll a correction back. Low speed, shallow turns, braking, poor accuracy, stale/reordered fixes, inconsistent course, and noisy or implausible corrections cannot refine it. There is no rider step or refinement status in the UI. A lateral force exactly proportional to longitudinal acceleration remains physically unobservable with these two references because it changes the fitted slope exactly like mount yaw; the conservative straightness and fit gates reduce, but cannot eliminate, that residual ambiguity.

At the browser seam, `DeviceMotionEvent.rotationRate` is normalized from `alpha/beta/gamma` to explicit device `x/y/z`. The pure-math estimator integrates body roll for tip-in response, recovers world yaw from the physically rotated leaned body-rate vector, and complements it with the drift-free `atan(speed × yawRate / g)` anchor using the same platform-or-derived speed as the speedometer. Refinement uses a separate unsmoothed validated speed while the instrument and kinematic anchor retain their prior smoothing. GPS trust rejects reordered timestamps and expires by monotonic reception age without comparing GPS epoch time to `performance.now()`. The estimator remains gyro-only through GPS gaps, learns changing stationary gyro bias as a device-frame three-vector, slowly returns verified stationary lean to upright, and clamps signed output to ±60°. A missing or stalled gyro renders lean `N/A`; estimation still runs at sensor cadence while instrument DOM writes are capped at 5 Hz.

## Run reports

Ending a race freezes a detached report snapshot from that ended session's monotonic samples. It lists every completed lap and tied best lap, computes max speed and a trapezoidal time-weighted average only across explicitly fresh GPS intervals, keeps left/right lean maxima separate, and retains the top-speed sample's validated position, normalized monotonic timestamp, and lap context. Tapping a completed-lap row reveals accessible −/+ controls that move its tap boundary in exact 0.1 s steps, capped at ±0.5 s from the preserved original tap. Interior boundaries transfer time and samples between adjacent laps; the final completed boundary transfers time against the unfinished tail. The ended-session duration never changes, and invalid or reordered boundaries are disabled. A lone speed sample or silent GPS gap cannot invent average coverage; valid stationary fixes still contribute their full measured time. Without any valid coordinate fix all GPS-derived figures are unavailable. Missing sensor data and sessions with no completed laps render explicit empty states rather than fabricated zeroes.

`RUN n` is an in-memory counter and resets on reload. `NEW RUN` confirms before discarding an unexported report. `SAVE RUN` passes the latest report through the single stateless `RunStore.save(report)` seam, sharing complete versioned JSON and GPX when supported and otherwise downloading them; runs without location data export JSON alone. The report model reserves nullable `runId` and `riderId`. The track column auto-fits the recorded GPS trace without map tiles, colors it by speed or signed lean, and marks the retained top-speed point.

## First real track-day validation checklist

Do not diagnose the display while riding. Use only interactions permitted by the circuit organizer, keep attention on the track, and review readings after stopping.

### Before leaving home

- [ ] Confirm Pages reports a successful deployment from the intended branch and the exact `/TrackMaster/` URL loads.
- [ ] Install/update Apex online and pass the complete cold-offline test above twice.
- [ ] Confirm the recorder URL with `?dev-recorder=1` is open and preserve these capture instructions offline.
- [ ] Verify iOS Motion, Location, Precise Location, Files/AirDrop export, battery charge, charging lead, and enough free device storage.
- [ ] Lock the phone in a rigid mount; note its landscape direction and ensure no control, cable, or case can shift it.
- [ ] Arrange an independent reference where possible: official transponder lap times, camera footage, dashboard speed, and known track direction.

### In the paddock and on the sighting lap

- [ ] With the bike fully upright and stationary, enable sensors, tap **ZERO NOW**, and keep it upright through the roughly one-second capture.
- [ ] Confirm upright lean settles near `0°`. Re-zero after any mount movement.
- [ ] Outdoors, distinguish `GPS · NO FIX`/`--` from a valid stationary `0 MPH`; do not start the validation session until fixes arrive.
- [ ] Confirm native landscape, safe-area clearance, readable contrast, and **KEEP AWAKE ON** during Race. Background and restore Apex, then verify it reacquires **ON**; if it shows unsupported or rejected, use the documented Auto-Lock fallback and record the failure.
- [ ] On a safe straight, compare speed trend with the bike/dashboard or video reference; review exact values later.
- [ ] Make deliberate lap taps and compare untrimmed times with the transponder. Use report trim only to correct tap timing (±0.5 s boundary model).

### After stopping

- [ ] End the race, verify every completed lap appears, total time is conserved during trim, and best-lap highlighting is credible.
- [ ] Confirm max/average speed, left/right max lean, track shape, top-speed point, and its lap/time context are plausible. Toggle the map between speed and lean coloring.
- [ ] Save the automatic raw recorder log first, then **SAVE RUN** for JSON/GPX. Confirm the files exist in Files/AirDrop before starting a new run or closing/reloading.
- [ ] Repeat a short session with cellular and Wi-Fi disabled, including report and export, to confirm actual circuit offline behavior.
- [ ] Record any sensor dropout, delayed GPS fix, wake-lock failure, share-sheet failure, thermal dimming, mount movement, or unexpected reload with its approximate lap/time.

### Lean-estimator warning signs that require recorder-backed retuning

- [ ] Lean decays materially toward `0°` through a steady-radius sustained corner.
- [ ] Left/right is reversed, or comparable left and right corners show a persistent unexplained asymmetry.
- [ ] Hard upright acceleration or braking produces a large false lean spike (cross-axis/forward-axis contamination).
- [ ] Straight upright sections drift away from `0°`, fail to recover, or oscillate despite a rigid mount.
- [ ] Tip-in response is consistently late, severely overshoots, or disagrees with video/reference timing.
- [ ] Output repeatedly clamps near `60°`, jumps discontinuously, or becomes `N/A` while motion delivery is otherwise present.
- [ ] Repeated sessions on the same corners disagree substantially without a mount, line, or speed change.

One anomalous corner is not enough to tune constants: bumps, camber, rider line, GPS cadence, mount flex, and tire slip are physical confounders. Retune only against exported raw logs plus independent context, then replay all captured sessions to check for regressions.

## What automation proves—and what it cannot

`npm test` statically verifies relative PWA metadata and runtime assets and deterministically executes service-worker install, activate, fetch, failure, cleanup, navigation, and update behavior. It also preserves the existing sensor, timing, report, trim, map, and export test suite. Syntax/JSON/PNG checks verify deployable file structure.

Automation cannot enable GitHub Pages, add an icon to a physical iPhone, prove iOS standalone chrome behavior, reproduce Safari storage eviction, grant/recover real permissions, obtain a satellite fix without data, measure device sensor cadence, validate Wake Lock/thermal behavior, exercise every share-sheet destination, or establish true motorcycle lean on track. In particular, wake-lock unit tests cover state transitions and races, not a physical display staying awake; the documented physical-device wake-lock check is a release gate. The cold-offline and first-track-day checklists are therefore release gates, not claims already proven by unit tests.
