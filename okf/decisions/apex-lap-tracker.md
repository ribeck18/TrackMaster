# Apex Lap Tracker — Decisions

Source of the visual design: the Claude Design handoff bundle
(`design_handoff_apex_lap_tracker/`). The design is authoritative for
look/layout; the decisions below override it wherever it conflicts with
physical or iOS reality.

## Product

**Stateless in v1.** No IndexedDB, no localStorage, no run history. All state
is in memory and dies on reload. A database is planned for a future version, so
persistence sits behind a single `RunStore.save(run)` seam and the run data
model reserves room for `runId` / `riderId`. Concurrency is a non-issue today:
GitHub Pages is a static CDN and every rider runs an isolated copy.

**`SAVE RUN` exports rather than persists.** It emits the finished run as JSON +
GPX through the iOS share sheet. Nothing is written to the device.

**Laps are marked by tapping only.** No GPS start/finish line detection.
Because a tap carries human reaction-time error, the report lets the rider trim
any lap by at most ±0.5 s relative to the original tap.

**Lap trim uses the boundary model.** A trim moves the tap *instant*, so
lengthening one lap shortens the next by the same amount. Total run time is
conserved and samples are reassigned across the moved boundary. Rejected: the
independent model, where per-lap durations move alone and stop summing to the
total.

## Sensors & physics

**Lean angle is NOT `DeviceOrientationEvent` roll.** A balanced motorcycle in a
steady corner aligns its vertical axis with the combined gravity+centripetal
vector, so any gravity-derived tilt reads ~0° mid-corner — wrong exactly when it
matters. Instead: a complementary filter fusing integrated gyro roll rate (fast
response) with the kinematic estimate `atan(v·ω_yaw / g)` from GPS speed and yaw
rate (drift-free long-term anchor). Lives behind a swappable `LeanEstimator`
interface so it can be tuned against recorded data.

**Calibration resolves a full bike frame, not a scalar offset.** Zeroing with
the bike upright captures gravity, which fixes the vertical axis only — roll and
pitch stay indistinguishable without a forward reference. Approach: assume the
phone's long landscape axis is the roll axis so lean works from the first corner,
then silently refine the forward axis from GPS heading + longitudinal
acceleration during the first provably straight, fast section. No extra rider
step.

**Permissions get their own gate screen.** A new `ENABLE SENSORS` state precedes
calibrate, because iOS requires the enable gesture before tap-initiated zero
capture can request motion access. Denial never dead-ends the app: no motion →
speed-and-laps stopwatch with the lean gauge showing `N/A`; no GPS → lean and
laps still work. Both show Settings-based recovery instructions, since a denied
`requestPermission()` can't re-prompt from the page.

**Speed shows `--` with a GPS warning when there is no fix**, and `0` only with
a fix and a stationary bike, so a dead sensor is distinguishable from a stopped
motorcycle.

## Platform

**Landscape is achieved by CSS transform, not orientation lock.** iOS Safari
does not support `screen.orientation.lock()` and ignores the manifest
`orientation` field. A rotate-your-phone prompt would hard-stick every rider who
has OS Rotation Lock enabled. So: when the viewport is portrait, rotate the app
root 90° and render landscape inside it. Safe here because the app has no
scrolling and only full-screen taps.

**Full offline-first PWA.** Manifest, icons, and a service worker caching
everything, because circuits have no cell service and GPS needs no data
connection. Cache name is build-stamped to prevent serving stale builds.

**HTTPS is a hard prerequisite** for both Geolocation and
`DeviceOrientationEvent.requestPermission()`. Hosting is GitHub Pages from this
repo, served at the `/trackmaster/` subpath — so all asset paths and the service
worker scope must be relative, never root-absolute.

## Engineering

**Vanilla ES modules, zero dependencies, no bundler or build step.** A push to
GitHub is the deploy. Pure math modules (lean estimator, lap/trim math, report
aggregation) are unit-tested with Node's built-in `node --test`, which needs no
packages installed.

**Dev tooling is a first-class deliverable**, because neither author can produce
45° of lean or 100 mph at a desk. Two dev-only halves behind a URL flag: a
simulator generating synthetic track sessions through the real pipeline, and a
raw sensor recorder whose exported log can be replayed to tune the filter
against actual riding data. The recorder exports a file; it stores nothing.

## Report

**The track map renders the real GPS polyline** as an auto-fit SVG with no map
tiles or network. Segments are colored by speed by default; tapping the map
toggles to lean-angle coloring.

**`BACK STRAIGHT · LAP 2` is not buildable** — naming track sections needs a
per-circuit database. Replaced with derivable text of the same shape:
`LAP 2 · 0:47 INTO LAP`.

## Standing assumptions

- MPH only; no unit toggle.
- `RUN n` counts runs within the page session (in-memory, resets on reload).
- `NEW RUN` confirms before discarding a run that has not been exported.
- Big numerals update at ~5 Hz, integer MPH, lightly smoothed, to stay glanceable.
- Lean clamped to ±60°; the gauge arc spans ±52° as drawn.
- Sample buffer lives in RAM (~72k samples for a 20-minute session at 60 Hz).
- The prototype's dev state switcher and phone bezel chrome are never shipped.
