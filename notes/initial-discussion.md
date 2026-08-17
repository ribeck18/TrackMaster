# Apex Lap Tracker — Initial Discussion

A record of the planning conversation that preceded any implementation, plus the
resulting build plan. Written so it can be read cold, without the chat.

- **Project:** TrackMaster / "Apex Lap Tracker"
- **Branch:** `claude/iphone-moto-lap-tracker-09b12f`
- **Date:** 2026-08-01

---

## 1. The brief

An iPhone-mounted web application for motorcycle track-day riders. The phone is
bar-mounted in landscape and glanced at while riding. It shows, live:

1. **Speed** — from GPS.
2. **Lean angle** — how far the bike is leaned left/right, from the phone's IMU.
3. **Lap time** — a running lap timer.

Written in plain JavaScript, HTML and CSS, as a fully client-side web app. The
rider zeroes the lean sensor while holding the bike upright, enters Race Mode to
record a session, and reviews a detailed report afterwards. The app is
**stateless for now**; a database is planned for a future version.

## 2. Source material

A Claude Design handoff bundle (`design_handoff_apex_lap_tracker/`) containing a
static high-fidelity prototype (`Apex Lap Tracker.dc.html`) and a README of
design tokens, per-screen component specs, and a sketch of the sensor work.

The design is **authoritative for look and layout** — colors, typography,
spacing, sizing, and the lean-gauge SVG geometry are final and reproduced
exactly. The prototype contains **no real sensor logic**; every speed, lean and
time value in it is a hard-coded placeholder pose.

The prototype's dev state-switcher pill bar and the phone bezel / Dynamic Island
chrome exist only to depict a phone and are **never shipped**.

### Design tokens (from the handoff, reproduced exactly)

| Token | Value |
|---|---|
| Screen surface | `#08090a` |
| Body gradient | `radial-gradient(circle at 50% 30%, #17191c 0%, #0a0b0d 70%)` |
| Text primary | `#f4f6f2` |
| Accent green (hi-vis) | `#b6ff2e` |
| Alert red | `#ff4d4d` |
| Hairline | `rgba(255,255,255,.1)` |
| Card fill | `rgba(255,255,255,.04)` |

Typefaces: **Rajdhani** (500/600/700) for numerals, titles and buttons;
**Space Mono** (400/700) for eyebrow labels, units and meta text, always
uppercase with 2–5px letter-spacing. Reference frame is 960 × 444 (~2.16:1),
scaled fluidly to fill the viewport.

---

## 3. The interview

Twelve questions, asked one at a time, each with a recommendation. Answers and
reasoning below.

### Q1 — "Completely stateless" vs. the SAVE RUN button

**Conflict.** The brief said the app is completely stateless; the handoff said
`SAVE RUN` persists sessions to IndexedDB/localStorage so runs can be reviewed
later. Both cannot be true, and the answer decides whether a run-history data
model exists at all.

**Decision: truly stateless in v1.** No IndexedDB, no localStorage, no run
history. All state lives in memory and dies on reload. A database feature is
planned for a future version.

**Consequence:** persistence sits behind a single `RunStore.save(run)` seam, and
the run data model reserves room for `runId` / `riderId` so a future backend
attaches without reworking it. `SAVE RUN` stays in the UI (design fidelity) and
exports the run as JSON + GPX through the iOS share sheet — the rider keeps
their data, the app stores nothing.

**Related question raised:** *what happens if two people use the site at once?*
Nothing — they cannot affect each other. GitHub Pages is a static CDN, and every
piece of state lives in one phone's RAM. Two riders are two isolated copies of
the same program. A thousand riders would be a non-event. That changes the day
the database lands, at which point identity becomes a real question.

### Q2 — Lean angle: the spec is physically wrong

**The problem.** The handoff said to take `DeviceOrientationEvent` roll and
subtract the calibrated zero. That works in the paddock and lies on track.

A motorcycle in a steady-state corner leans to exactly the angle where gravity
plus centripetal force sum to a vector pointing straight down through the
wheels — that is what makes it a balanced corner. But every gravity-derived tilt
sensor, including iOS's fused `deviceorientation`, measures orientation
*relative to that same combined vector*. Mid-corner the phone genuinely believes
it is upright. The needle would spike on tip-in, then sag toward 0° while the
rider is pinned over at 45° through the apex — wrong precisely when it matters.

**Options considered:**

- *Gyro integration* — integrate `DeviceMotionEvent.rotationRate` roll. Correct
  through the corner, but drifts; needs a correction rule that only trusts
  gravity when the bike is verifiably upright *and* straight.
- *Kinematic estimate* — `lean = atan(v · ω_yaw / g)` from GPS speed and yaw
  rate. Drift-free and solid in sustained corners, but noisy below ~15 mph and
  lags initial tip-in.
- *Fuse both* — complementary filter, gyro for response, kinematic as the
  long-term anchor replacing gravity.

**Decision: fuse both.** Behind a swappable `LeanEstimator` interface so it is
testable and can be tuned against recorded data.

### Q3 — Lap detection

**The tension.** A full-screen tap target is right for gloved operation, but as
a *timing* mechanism it injects roughly ±0.3–0.5 s of reaction-time error per
lap — larger than the differences riders are trying to see — and it puts a hand
on the phone at the end of a straight.

The alternative was a GPS start/finish line with crossing times interpolated
between fixes. Caveat: Safari's `watchPosition` delivers ~1 Hz, which is ~150 ft
of travel at 100 mph, so interpolation is what makes it work at all; done right
it reaches roughly ±0.05 s.

**Decision: tap-only for now** — plus a new feature: the rider can adjust a lap
time after the fact, **by no more than half a second**.

### Q4 — What a lap trim actually moves

A rider trimming a lap is correcting *when they tapped*, not inventing a
different lap. Two models give different answers:

- **Boundary model** — the trim moves the tap instant. Lengthening lap 1 by
  0.2 s shortens lap 2 by 0.2 s. Total run time never changes, because the rider
  did not ride any longer, and samples either side of the boundary get
  reassigned so per-lap stats stay honest.
- **Independent model** — each lap duration is nudged alone. Simpler, but lap
  times stop summing to the total and a rider could pad every lap to fake a
  better best lap.

**Decision: boundary model.**

**Control:** tapping a lap row in the report reveals −/+ steppers in 0.1 s
increments (±5 steps max), clamped against the original tap, always reversible.

### Q5 — Hosting

**Hard gate, not a preference.** Both `DeviceOrientationEvent.requestPermission()`
and Geolocation are HTTPS-only on iOS with no exceptions, and `localhost` does
not help because the phone is not the machine serving the page. Opening the file
in Safari, or hitting a laptop's LAN IP, produces an app where speed and lean
are permanently dead. Deployment is a prerequisite for testing anything.

**Decision: GitHub Pages from this repo.** Free HTTPS, installable to the home
screen, redeploys on push.

**Consequence:** Pages serves at the `/trackmaster/` subpath, not the domain
root, so **all asset paths and the service-worker scope must be relative**,
never root-absolute. The repo must be public unless on a paid GitHub plan.

### Q6 — Test tooling

Neither party can reproduce a track session at a desk: no iPhone, no GPS, no
motorcycle on one side; no way to generate 45° of lean or 100 mph on the other.
Without deliberate tooling, the first honest test of the fused estimator, the lap
logic and the report math is on a live track, at speed, in a helmet, wearing
gloves, with no console.

**Decision: simulator + raw record/replay**, dev-only behind a URL flag.

- **Simulator** — generates a synthetic lap of a plausible track, driving real
  speed/yaw/roll streams through the exact same estimator and lap pipeline the
  sensors feed.
- **Raw recorder** — captures the untouched sensor stream during a real session
  for export, so an actual ride can be replayed frame-for-frame at a desk and
  the filter tuned against real data. It exports a file; it stores nothing.

### Q7 — Orientation

**iOS cannot be forced into landscape.** `screen.orientation.lock()` is
unsupported in iOS Safari and iOS ignores the manifest `orientation` field.

The handoff's own fallback — prompt the user to rotate — walks into a trap: a
large share of riders have OS **Rotation Lock** enabled, for whom Safari reports
portrait forever regardless of how the phone is physically mounted. They would
bolt the phone to the bars sideways, stare at "please rotate your phone", rotate
it, and nothing would happen. The page cannot detect or clear that setting.

**Decision: CSS-rotate into landscape.** When the viewport is portrait, apply a
90° transform to the app root and render landscape inside a portrait window.
Normally this costs scroll behavior and touch-coordinate sanity, but this app has
no scrolling and its only gestures are full-screen taps, so the usual downsides
do not apply. A one-line hint suggests disabling Rotation Lock for the native
experience.

### Q8 — Stack

The brief said JavaScript, HTML and CSS; the handoff suggested React/Vue/Svelte.

**Decision: plain ES modules, zero dependencies, no bundler, no build step.** A
push *is* the deploy — no CI, no build to break, and every running line is
readable. The app is four mutually-exclusive screens and some SVG updates; a
framework would carry more ceremony than it saves.

**Tests are the exception.** The lean estimator, the lap/trim math and the report
aggregation are pure functions over numbers, and they are exactly the code that
cannot be verified by eye on a bike. Node's built-in `node --test` runs them on
plain ES modules with **zero packages installed**.

### Q9 — The track map, and one label that cannot be built

The recorded GPS polyline renders as an auto-fit SVG with the top-speed marker —
no map tiles, no Leaflet, no network. That is the rider's actual line around the
circuit, recognizable and far better than the striped placeholder.

The label under it was the problem. The design reads `104 MPH` /
`BACK STRAIGHT · LAP 2`. The app has no idea a stretch of tarmac is called the
back straight — that needs a per-circuit database of named sections, a whole
product unto itself.

**Decision:** replace with derivable text of the same shape and typography:
`LAP 2 · 0:47 INTO LAP`. And **color the trace by speed by default, tapping the
map to toggle to lean-angle coloring** — nearly free to build, and it turns the
map from decoration into the most informative thing in the report.

### Q10 — Permissions and calibration

iOS requires motion permission to be requested inside a user gesture. Denial is
also close to unrecoverable from inside the page: once a rider taps Don't Allow,
further `requestPermission()` calls resolve `denied` instantly with no prompt.
Recovery means Settings → Safari → Motion & Orientation Access, or clearing site
data — not something to discover in a pit lane.

**Decision: add an `ENABLE SENSORS` gate screen** before calibrate, styled to
match. One tap requests motion + GPS together. The Calibrate screen instructs
the rider to hold the bike upright; tapping `ZERO NOW` starts a roughly
one-second stable gravity-and-gyro capture before advancing. It is also the
natural home for denied-state recovery instructions.

**Degradation rules:** denial never dead-ends the app. No motion permission → a
speed-and-laps stopwatch with the lean gauge showing `N/A`. No GPS → lean and
laps still work. Speed shows `--` with a small GPS warning when there is no fix,
and `0` only when there is a fix and the bike is genuinely stopped, so a dead
sensor is distinguishable from a stationary motorcycle.

### Q11 — Offline

Circuits have terrible cell service. "Open `ribeck18.github.io/trackmaster` on
your phone" means: no bars in the paddock, Safari cannot fetch the page, no app.
A warm browser cache will not reliably save it either — Safari evicts
aggressively and the phone has probably been asleep in a tank bag since the
drive up.

**Decision: full offline-first PWA.** Manifest, icons, and a service worker
caching everything. The app installs to the home screen, launches without Safari
chrome, and runs with zero network. GPS is a radio fix, not a data connection, so
the sensors do not care. Cache names are build-stamped, because a badly versioned
service worker will happily serve a rider a stale build forever.

### Q12 — Calibration does not fully define the sensor frame

Tapping ZERO with the bike vertical captures one thing: the direction of gravity
in the phone's coordinate frame. That nails the bike's *vertical* axis and
nothing else — it says nothing about which way is *forward*, and without that,
roll and pitch are indistinguishable. A phone mounted with any yaw twist in the
cradle (which is every real mount) would smear braking pitch into the lean
reading. Because gyro rates are being integrated, that error compounds rather
than averaging out.

**Options considered:** assume the mount (instant, few degrees of error); ask for
an explicit straight-line calibration (accurate, but adds a step that must be
performed while rolling); or assume then refine.

**Decision: assume, then silently refine.** Use the assumed mount axis so lean
works from the first corner, then auto-correct the forward axis from GPS heading
and longitudinal acceleration the first time the rider is provably going straight
and fast. No extra rider step; accuracy improves on its own within a lap.

---

## 4. The plan

### What we're building

A zero-dependency, offline-capable web app served from GitHub Pages, mounted on
an iPhone in landscape on a motorcycle's handlebars. Five states —
**Enable → Calibrate → Ready → Race → Report** — rendering live GPS speed, a
physically-correct lean angle, and lap times, with a detailed post-session
report. Nothing is stored on the device.

### Deviations from the handoff spec

Each is deliberate; each is individually vetoable.

| Spec says | We're doing | Why |
|---|---|---|
| Lean = `DeviceOrientation` roll − zero | Fused gyro + kinematic filter | Gravity-based tilt reads ~0° mid-corner |
| Zero = scalar offset | Zero = full bike-frame capture + silent forward-axis refinement | One gravity vector can't separate roll from pitch |
| Lock to landscape | CSS-rotate the app root when portrait | iOS has no orientation lock; a rotate-prompt hard-sticks Rotation Lock users |
| Persist runs to IndexedDB | Stateless; `SAVE RUN` exports JSON + GPX | Owner's call — DB comes later |
| Calibrate is the first screen | `ENABLE SENSORS` gate precedes it | Permission needs a gesture before the tap-initiated upright capture |
| `BACK STRAIGHT · LAP 2` | `LAP 2 · 0:47 INTO LAP` | Named track sections need a circuit database |
| Striped map placeholder | Real GPS polyline, speed/lean color toggle | The data is already recorded |
| — | Lap trim (±0.5 s, boundary model) in report | Owner's addition |
| Dev state switcher, phone bezel | Removed | Spec says so |

### File layout

```
index.html · manifest.webmanifest · sw.js · icons/ · css/app.css
js/
  main.js                 state machine, screen routing
  ui/      screens.js · gauge.js · level.js · trackmap.js · laprows.js
  sensors/ permissions.js · motion.js · gps.js · wakelock.js
  core/    frame.js · lean.js · laps.js · report.js · recorder.js · export.js
  dev/     sim.js · replay.js
test/      lean.test.js · laps.test.js · report.test.js
```

### Build order

1. **Shell & design fidelity** — all five screens matching the prototype exactly
   (fonts, tokens, gauge SVG math, safe-area insets), state machine, CSS-rotate
   landscape. Verifiable in any desktop browser.
2. **Dev harness** — simulator driving synthetic speed/yaw/roll streams through
   the real pipeline. Everything below becomes testable at a desk.
3. **Sensors** — permission gate, motion + GPS subscriptions, wake lock,
   degraded/denied states, `--` vs `0`.
4. **Lean core** — bike-frame calibration, complementary filter, silent
   forward-axis refinement, raw recorder + replay. Unit tested.
5. **Laps & trim** — tap-to-lap, boundary-model trim with ±0.5 s clamp and
   stepper UI. Unit tested.
6. **Report** — aggregation, track map with color toggle, JSON + GPX export via
   the share sheet.
7. **PWA** — manifest, icons, service worker, build-stamped cache.
8. **Deploy** — push to `claude/iphone-moto-lap-tracker-09b12f`, README covering
   how to enable Pages and an on-track validation checklist.

### Standing assumptions

- MPH only; no unit toggle.
- `RUN n` counts runs within the page session (in-memory, resets on reload).
- `NEW RUN` confirms before discarding a run that has not been exported.
- Big numerals refresh at ~5 Hz, integer MPH, lightly smoothed, to stay
  glanceable.
- Lean clamped to ±60°; the gauge arc spans ±52° as drawn.
- Sample buffer lives in RAM (~72k samples for a 20-minute session at 60 Hz).

### What this plan does *not* deliver

No run history or database. No GPS lap detection. No named track sections. No
accounts. And the lean filter's constants will be a first guess until the
recorder captures a real session — step 4 exists specifically to make that tuning
pass cheap.

---

## 5. Status

Plan awaiting approval. No application code written yet. The decisions above are
also recorded in `okf/decisions/apex-lap-tracker.md` as the project's working
memory.
