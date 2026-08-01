# Handoff: Apex Lap Tracker — Motorcycle Track Companion (iPhone Web App)

## Overview
Apex Lap Tracker is a **single-screen web app for motorcycle track-day riders**. It runs on an iPhone that is **mounted to the motorcycle in landscape orientation** and glanced at (or reviewed) between/after track sessions. It uses the phone's own sensors to show, in real time:

1. **Speed** — derived from GPS.
2. **Lean angle** — how far the bike is leaned over left/right, derived from the phone's motion/orientation sensors.
3. **Lap time** — a running lap timer.

The rider first **zeroes (calibrates)** the lean sensor while the bike is held upright, then enters **Race Mode** to record a session. After the session they get a **detailed run report**.

The core design constraint is **glanceability at speed**: on the live screens the numbers are huge and clutter is minimal, because the rider can only look for a fraction of a second. The **report**, by contrast, is intentionally dense and detailed because it is reviewed while stopped.

### Why each piece exists
- **Landscape, mount-friendly, huge numbers** — the phone is bar-mounted and read at a glance while riding; small text or portrait layout would be unusable.
- **Calibration/zero step** — the phone is never mounted at a perfectly known angle, so the raw sensor "upright" reading is arbitrary. Zeroing while the bike is held vertical establishes the 0° reference so that reported lean angles are meaningful.
- **Tap = next lap; END RACE = stop** — riders wear gloves and can't do precise UI. A full-screen tap target advances laps; a single dedicated button ends the session. Everything is operable with one clumsy tap.
- **Post-run report** — the rider wants to review max/avg speed, per-lap times, and max lean after the session, not while riding.

---

## About the Design Files
The file in this bundle (`Apex Lap Tracker.dc.html`) is a **design reference created in HTML** — a static prototype showing the intended **look, layout, and interaction flow**. It is **not production code to ship directly**, and it contains **no real sensor logic** — all speed / lean / time values are hard-coded placeholder poses.

**The task** is to recreate this design as a real iPhone-ready web app in the target codebase's environment (or, if none exists yet, choose an appropriate stack — see "Recommended Stack") and wire up the **real backend/sensor behavior** described below. Match the visual design pixel-for-pixel; replace the static numbers with live data.

> Note on the file format: `.dc.html` is an authoring format from the design tool. Treat it as an HTML/CSS/JS reference — read the markup and inline styles for exact values. Do not attempt to depend on its runtime.

## Fidelity
**High-fidelity (hifi).** Colors, typography, spacing, sizing, and layout in the prototype are final and should be reproduced exactly. The values in the "Design Tokens" and per-screen "Components" sections below are authoritative.

---

## Global Layout & Framing

- **Orientation:** Landscape only. Lock to landscape; if the device is held portrait, prompt the user to rotate.
- **Design frame:** The prototype is drawn inside a **960 × 444 px** rounded phone screen (this represents the iPhone's landscape safe area / viewport). In production, the app should **fill the device viewport** (`100dvw × 100dvh`) in landscape. Treat 960×444 as the reference aspect ratio (~2.16:1) and scale fluidly.
- **Safe areas / notch:** The prototype reserves space on the **left edge** for the landscape Dynamic Island / notch — note the **left padding of ~62px** on every screen's content. In production, honor `env(safe-area-inset-*)` instead of a fixed value; the ~62px is the design's stand-in for the left inset.
- **Background:** App background is near-black. Body uses a radial gradient `radial-gradient(circle at 50% 30%, #17191c 0%, #0a0b0d 70%)`; the screen surface itself is `#08090a`.
- **Keep-awake:** The screen must not sleep during Race Mode (use a Wake Lock).
- **The bezel/rounded-corner chrome and the "Dynamic Island" pill in the prototype are just to depict the phone** — do not render them in the real app.

### Dev state switcher (prototype only — DO NOT SHIP)
The prototype has a small pill bar pinned to **top-center** with `ZERO · READY · RACE · REPORT` buttons. This exists **only** so the designer can jump between states. **Remove it from production.** The real app moves between states via the flow described in "Interactions & Behavior".

---

## Screens / Views

The app is **one page** with **four mutually-exclusive states**: `cal` (Calibrate) → `ready` (Ready) → `race` (Live Race) → `report` (Run Report). Only one is visible at a time.

### 1. Calibrate (`cal`) — the landing/entry state
- **Purpose:** Establish the 0° lean reference. This is the first thing shown when the app opens.
- **Layout:** Single centered column, vertically and horizontally centered, `gap: 18px`, text centered. Content left-padded ~62px for the notch inset.
- **Components (top → bottom):**
  - **Eyebrow label:** `STEP 1 · CALIBRATE` — Space Mono, 12px, `letter-spacing: 3px`, color `#b6ff2e` (accent green), `margin-top: 40px`.
  - **Level indicator:** A 118×118px circle, `border: 2px solid rgba(255,255,255,.18)`, containing a horizontal + vertical crosshair line (`rgba(255,255,255,.14)`), a 74px dashed inner ring (`rgba(255,255,255,.16)`), and a **green bubble dot** — 22px circle, `#b6ff2e`, glow `box-shadow: 0 0 18px rgba(182,255,46,.6)`, offset `transform: translate(9px,-6px)` to depict an off-level bubble. In production this bubble should move live with the phone's tilt (a real spirit-level), settling to center when level.
  - **Title:** `LEVEL & ZERO SENSORS` — Rajdhani 700, 38px, `letter-spacing: 1px`.
  - **Body copy:** `Mount your phone and hold the bike fully upright. Tap zero to set the current position as 0° lean.` — Rajdhani, 17px, `color: rgba(255,255,255,.55)`, `line-height: 1.35`, `max-width: 520px`.
  - **ZERO NOW button:** green pill. Background `#b6ff2e`, text `#0a0b0d`, Rajdhani 700, 22px, `letter-spacing: 3px`, `padding: 16px 58px`, `border-radius: 40px`, `box-shadow: 0 0 30px rgba(182,255,46,.35)`.
- **Action:** Tapping **ZERO NOW** captures the current sensor orientation as the zero reference and advances to **Ready**.

### 2. Ready (`ready`) — calibrated, idle
- **Purpose:** Sensors are zeroed; the rider is stopped and ready to start a session. Shows live gauges at rest so the rider can confirm zeroing worked (bike upright should read ~0°).
- **Layout:** Vertical flex. `padding: 40px 40px 0 62px`.
  - **Top region** (`flex: 1`, horizontal flex, `gap: 20px`, vertically centered): two equal columns split by a vertical hairline divider (`1px`, 70% height, `rgba(255,255,255,.1)`):
    - **Left — SPEED:** eyebrow `SPEED` (Space Mono 12px, `rgba(255,255,255,.45)`); big number `0` (Rajdhani 700, **170px**, `line-height: .8`, `color: rgba(255,255,255,.82)`); unit `MPH` (Space Mono 16px, `letter-spacing: 5px`, `rgba(255,255,255,.4)`).
    - **Right — LEAN ANGLE:** eyebrow `LEAN ANGLE`; the **lean gauge** (see "Lean Gauge Component") sized in a `300×150` box; below it a baseline-aligned row (`gap: 14px`) with big `0°` (Rajdhani 700, 92px, `rgba(255,255,255,.82)`) and label `LEVEL` (Space Mono 16px, `letter-spacing: 5px`, `rgba(255,255,255,.4)`).
  - **Bottom strip** (`height: 82px`, `border-top: 1px solid rgba(255,255,255,.1)`, horizontal flex centered, `gap: 26px`): `LAP TIME` eyebrow · `00:00.0` (Rajdhani 700, 60px) · hairline divider · **prompt** `TAP ANYWHERE TO START RACE` (Space Mono 13px, `letter-spacing: 3px`, `#b6ff2e`).
- **Action:** Tapping **anywhere** on this screen starts a session → **Race**.

### 3. Live Race (`race`) — glanceability-first, recording
- **Purpose:** Actively recording the session. Maximum glanceability. This is the screen the rider looks at while riding.
- **Layout:** Same structure as Ready (two gauges on top, timer strip on bottom), but with live/recording values and slightly larger speed:
  - `padding: 40px 40px 0 62px`.
  - **REC indicator** — absolutely positioned top-left (`left: 62px, top: 16px`): a 9px pulsing-red dot (`#ff4d4d`, glow `0 0 10px #ff4d4d`) + text `REC` (Space Mono 12px, `letter-spacing: 3px`, `#ff4d4d`).
  - **END RACE button** — absolutely positioned top-right (`right: 40px, top: 12px`, above the tap layer, `z-index` high). Red pill: background `#ff4d4d`, text `#0a0b0d`, Space Mono 700, 12px, `letter-spacing: 3px`, `padding: 9px 18px`, `border-radius: 20px`, glow `0 0 18px rgba(255,77,77,.4)`. **Its click must NOT bubble to the screen's next-lap tap handler** (stop propagation).
  - **"TAP ANYWHERE FOR NEXT LAP" hint** — absolutely positioned, centered, `bottom: 92px` (just above the timer strip): Space Mono 11px, `letter-spacing: 3px`, `rgba(255,255,255,.35)`.
  - **Top region** two columns split by hairline:
    - **Left — SPEED:** eyebrow `SPEED`; number `87` in **accent green** `#b6ff2e`, Rajdhani 700, **176px**, `line-height: .8`, glow `text-shadow: 0 0 40px rgba(182,255,46,.35)`; unit `MPH` (Space Mono 16px, `letter-spacing: 5px`, `rgba(255,255,255,.5)`).
    - **Right — LEAN ANGLE:** eyebrow `LEAN ANGLE`; lean gauge in `300×150` box; below, a baseline row (`gap: 14px`, `margin-top: 8px`) with `42°` in green `#b6ff2e` (Rajdhani 700, 92px, glow `0 0 30px rgba(182,255,46,.4)`) and side label `LEFT` (Space Mono 16px, `letter-spacing: 5px`, `rgba(255,255,255,.6)`). The side label is **`LEFT` or `RIGHT`** depending on lean direction.
  - **Bottom timer strip** (`height: 82px`, `border-top` hairline, centered flex, `gap: 26px`): `LAP TIME` eyebrow · **current lap time** e.g. `01:23.4` (Rajdhani 700, 66px, `letter-spacing: 1px`) · **current lap number** `LAP 2` (Space Mono 14px, `letter-spacing: 3px`, `#b6ff2e`) · hairline divider · **previous lap** `LAST 01:31.2` (Space Mono 13px, `rgba(255,255,255,.4)`).
- **Actions:**
  - **Tap anywhere on the screen** (except the END RACE button) = **complete current lap / start next lap**: record the just-finished lap's time, increment the lap counter, reset the running lap timer to `00:00.0`, and set `LAST` to the lap just completed.
  - **END RACE button** = stop recording and go to **Report**.

### 4. Run Report (`report`) — detailed, reviewed while stopped
- **Purpose:** Post-session summary. Intentionally dense/detailed.
- **Layout:** Vertical flex, `padding: 20px 34px 18px 60px`, `gap: 12px`.
  - **Header row** (`border-bottom: 1px solid rgba(255,255,255,.1)`, `padding-bottom: 10px`, space-between, baseline-aligned):
    - Left: title `RUN REPORT` (Rajdhani 700, 30px, `letter-spacing: 1px`) + meta `RUN 1 · 3 LAPS · 04:20.5 TOTAL` (Space Mono 12px, `letter-spacing: 2px`, `rgba(255,255,255,.45)`), `gap: 14px`.
    - Right: `BEST 01:23.4` (Space Mono 12px, `letter-spacing: 2px`, `#b6ff2e`).
  - **Body** (`flex: 1`, CSS grid, `grid-template-columns: 1fr 1.15fr 1.1fr`, `gap: 22px`):
    - **Column A — LAP TIMES:** eyebrow `LAP TIMES`; then one row per lap. Each row: rounded 9px, `padding: 8px 12px`, space-between, label on left (Space Mono 12px) + time on right (Rajdhani, 24px). Normal rows use `background: rgba(255,255,255,.04)`. The **best lap** is highlighted: `background: rgba(182,255,46,.1)`, `border: 1px solid rgba(182,255,46,.4)`, label and time in `#b6ff2e` and reads e.g. `LAP 2 · BEST`.
    - **Column B — STAT GRID:** a 2×2 grid (`gap: 10px`) of stat cards. Each card: `border-radius: 11px`, `background: rgba(255,255,255,.04)`, `padding: 11px 14px`, vertically centered, with a Space Mono 11px `letter-spacing: 2px` label (`rgba(255,255,255,.4)`) over a big value (Rajdhani 700, 40px, `line-height: 1`). The four cards:
      - `MAX SPEED` → `104` + small ` MPH` suffix (16px, `rgba(255,255,255,.45)`).
      - `AVG SPEED` → `78` + ` MPH`.
      - `MAX LEAN · LEFT` → `48°` in green `#b6ff2e`.
      - `MAX LEAN · RIGHT` → `44°` in green `#b6ff2e`.
    - **Column C — TRACK / TOP SPEED POINT:** eyebrow `TRACK · TOP SPEED POINT`; then a **map placeholder** (`flex: 1`, `border-radius: 11px`, `background: #101210`, `border: 1px solid rgba(255,255,255,.07)`) filled with a diagonal striped SVG pattern, a centered `TRACK MAP` caption (Space Mono 11px, `rgba(255,255,255,.3)`), and a **green marker dot** (12px, `#b6ff2e`, glow) positioned where top speed occurred. Below the map: a callout card (`background: rgba(182,255,46,.1)`, `border: 1px solid rgba(182,255,46,.3)`, `border-radius: 9px`, `padding: 9px 12px`) with `104 MPH` (Rajdhani 700, 20px, `#b6ff2e`) over `BACK STRAIGHT · LAP 2` (Space Mono 10px, `rgba(255,255,255,.5)`). **In production the map should render the actual GPS track of the run** with a marker at the top-speed point.
  - **Footer buttons** (horizontal flex, right-aligned, `gap: 12px`):
    - `NEW RUN` — outline pill: `border: 1px solid rgba(255,255,255,.3)`, `padding: 11px 30px`, `border-radius: 30px`, Rajdhani 700, 16px, `letter-spacing: 3px`, `color: rgba(255,255,255,.85)`. Returns to **Ready**.
    - `SAVE RUN` — solid green pill: `background: #b6ff2e`, `color: #0a0b0d`, `padding: 11px 34px`, `border-radius: 30px`, Rajdhani 700, 16px, `letter-spacing: 3px`, glow `0 0 24px rgba(182,255,46,.3)`. Persists the run (see "Data & Persistence").
- **Action:** `NEW RUN` → Ready (discard or keep, per product choice). `SAVE RUN` → persist the session record.

---

## Lean Gauge Component (shared)
An arc dial with a needle, used on Ready and Race.

- **Geometry (SVG, `viewBox="0 0 400 232"`):** pivot/hub at `(200, 210)`, arc radius `R = 182`. The arc spans **−52° to +52°** from vertical (0° = straight up, negative = left lean, positive = right lean). Rendered in a `300 × 150` box with `overflow: hidden` (SVG scales to fit; the hub sits near the bottom edge).
- **Track arc:** the full −52°→+52° arc, `stroke: rgba(255,255,255,.1)`, `stroke-width: 16`, round caps.
- **Active arc:** an arc drawn from 0° (top) to the current lean angle in accent green `#b6ff2e`, `stroke-width: 16`, round caps — fills from center toward the current lean, so more lean = more green.
- **Ticks:** lines at −45, −30, −15, 0, +15, +30, +45 degrees. Major ticks at −45/0/+45 are longer (inner radius 150) and thicker (3px); minor ticks inner radius 160, 2px; all `stroke: rgba(255,255,255,.35)`.
- **Needle:** a line from the hub `(200,210)` outward to radius **116** at the current lean angle, `#b6ff2e`, `stroke-width: 6`, round cap, `filter: drop-shadow(0 0 6px rgba(182,255,46,.7))`.
- **Hub:** a 14px circle at the pivot, `fill: #0c0f0a`, `stroke: #b6ff2e`, `stroke-width: 4`.
- **Point math:** for a lean angle `θ` (degrees), a point at radius `r` is `x = 200 + r·sin(θ)`, `y = 210 − r·cos(θ)`.
- The big numeric readout (`42°` / `0°`) and the `LEFT`/`RIGHT`/`LEVEL` label sit **below** the gauge box, not inside it (this was intentional so the needle/hub never overlap the digits).

---

## Interactions & Behavior (flow)

```
[app open] → CAL
CAL:    tap "ZERO NOW"           → capture zero reference   → READY
READY:  tap anywhere             → start session (lap 1, timer running) → RACE
RACE:   tap anywhere (not button)→ complete lap, ++lap, reset lap timer, set LAST
RACE:   tap "END RACE"           → stop recording, compute report → REPORT
REPORT: tap "NEW RUN"            → READY
REPORT: tap "SAVE RUN"           → persist session, then (product choice: stay / READY)
```

- **Tap targets are deliberately huge** (full-screen on Ready/Race) for gloved operation.
- **END RACE** must stop event propagation so it doesn't also fire the "next lap" tap.
- **Recording** runs continuously during RACE: sample GPS speed and lean angle at a steady rate (recommend 10–20 Hz for lean, ~1–5 Hz for GPS depending on device) and timestamp each sample so the report and track can be computed.
- No animations beyond the natural live updating of numbers/needle and the pulsing REC dot. Keep transitions minimal/instant — this is an instrument, not a marketing page.

---

## State Management

Prototype state (extend for production): `screen` (`cal|ready|race|report`), `lap`, `lapTime`, `lastLap`.

**Production state needed:**
- `screen` / app phase.
- `zeroReference` — the captured device orientation quaternion/euler that defines 0° lean (set at calibration; persists for the session, optionally across launches).
- **Live values:** `currentSpeed` (mph), `currentLean` (signed degrees; sign → left/right), `currentLapElapsed` (ms).
- **Session recording:** `sessionStartTime`, array of `laps` (each: index, duration, best flag), `currentLapStartTime`, and a **time-series buffer** of `{ t, lat, lng, speed, lean }` samples for the report/track.
- **Derived report values** (computed on END RACE): total time, per-lap times, best lap, max speed, avg speed, max lean left, max lean right, top-speed value + its GPS location/time.

---

## Backend / Sensor Requirements (what Claude Code needs to build)

This is the real work behind the static prototype:

1. **GPS speed** — use the Geolocation API (`watchPosition`, `enableHighAccuracy: true`). Prefer the `coords.speed` value (m/s) when present; otherwise derive speed from successive positions. Convert to **MPH** (`m/s × 2.23694`). Smooth lightly to avoid jitter. Display `0` when stationary/no fix.
2. **Lean angle** — use `DeviceOrientationEvent` (and/or `DeviceMotionEvent`) from the phone's IMU. On iOS Safari this requires an explicit **user-gesture permission prompt** (`DeviceOrientationEvent.requestPermission()`) — trigger it on the calibrate screen / first tap. Compute the roll relative to the **captured zero reference** so lean is 0° when the bike is upright regardless of mount angle. Sign the result: left = negative, right = positive. Clamp/expect a usable range around ±60°.
3. **Calibration/zeroing** — on "ZERO NOW", snapshot the current orientation and store it as the reference; all subsequent lean readings are relative to it. Also drive the spirit-level bubble on the calibrate screen from live tilt.
4. **Lap timer** — high-resolution running timer (use `performance.now()`), formatted `MM:SS.d` (minutes:seconds.tenths). Reset per lap on tap; keep a list of completed lap durations.
5. **Report computation** — on END RACE, compute from the recorded sample buffer: max/avg speed, max lean left & right, per-lap times + best, and the top-speed point (value + GPS coord) for the map marker.
6. **Track map** — plot the recorded GPS polyline and place a marker at the top-speed sample. (Any map/canvas rendering of the lat/lng path; the prototype uses a striped placeholder.)
7. **Keep-awake** — request a Screen Wake Lock during RACE so the display doesn't sleep on the handlebars.
8. **Orientation lock** — lock/encourage landscape.
9. **Persistence** — "SAVE RUN" stores the session (laps, stats, track) locally (e.g. IndexedDB/localStorage) so runs can be reviewed later. No server is required for the prototype scope, but structure the data so a sync backend could be added.

### Recommended Stack (if no codebase exists yet)
A client-side PWA is the natural fit — it's iPhone-mounted, sensor-driven, and needs no server for the core loop. Any of React/Vue/Svelte + a small state store works; keep it a single-page app with the four states above. All sensor APIs (Geolocation, DeviceOrientation) are browser-native. Add it to the home screen as a PWA and lock landscape.

### Important iOS gotchas
- `DeviceOrientationEvent.requestPermission()` **must** be called from a user gesture (a tap) and only works over **HTTPS**.
- Geolocation also requires HTTPS and a permission grant.
- Provide graceful states when permission is denied or sensors are unavailable (the prototype does not depict these — add: a permission-request/denied message, and "GPS acquiring…" / "no signal" states for speed).

---

## Design Tokens

**Colors**
| Token | Value | Use |
|---|---|---|
| Screen surface | `#08090a` | app background |
| Body gradient | `radial-gradient(circle at 50% 30%, #17191c 0%, #0a0b0d 70%)` | outer background |
| Text primary | `#f4f6f2` | default text |
| Text 82% | `rgba(255,255,255,.82)` | resting big numbers |
| Text 55–45% | `rgba(255,255,255,.55)` / `.45` | body copy, eyebrows |
| Text 40–35% | `rgba(255,255,255,.4)` / `.35` | muted units/hints |
| Hairline | `rgba(255,255,255,.1)` | dividers, borders |
| Card fill | `rgba(255,255,255,.04)` | report stat cards |
| **Accent green (hi-vis)** | `#b6ff2e` | live data, active gauge, primary buttons, highlights |
| Accent green glow | `rgba(182,255,46,.3–.4)` | text/box shadows on accent |
| Accent green tint | `rgba(182,255,46,.1)` | highlighted card backgrounds |
| **Alert red** | `#ff4d4d` | REC dot, END RACE button |

**Typography**
- **Rajdhani** (Google Fonts), weights 500/600/700 — all numerals, titles, buttons. Condensed, technical, instrument-like.
- **Space Mono** (Google Fonts), weights 400/700 — all eyebrow labels, units, meta text; always UPPERCASE with wide `letter-spacing` (2–5px).
- Import: `https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap`
- Key sizes: live speed **170–176px**; live lean number **92px**; race lap time **66px**; ready lap time **60px**; report stat values **40px**; titles **30–38px**; buttons **16–22px**; eyebrows/units **11–16px**.

**Radius:** buttons/pills `20–40px`; cards `9–11px`; level circle `50%`.

**Shadows / glows:** green button `0 0 24–30px rgba(182,255,46,.3–.35)`; green text `0 0 30–40px rgba(182,255,46,.35–.4)`; red button `0 0 18px rgba(255,77,77,.4)`; needle `drop-shadow(0 0 6px rgba(182,255,46,.7))`.

**Spacing:** content left-pad ~62px (notch inset); screen paddings `20–40px`; gauge box `300×150`; timer strip height `82px`.

---

## Assets
- **Fonts:** Rajdhani + Space Mono via Google Fonts (links above). No other font assets.
- **Icons/graphics:** none are bitmap assets — the level indicator, lean gauge, REC dot, and map placeholder are all pure CSS/SVG. Reproduce them as vector.
- **Map:** the report track map is a **placeholder** (striped SVG). Production should render the real GPS polyline.
- No logos or third-party brand assets are used.

## Files
- `Apex Lap Tracker.dc.html` — the full static prototype (all four states + shared lean-gauge logic). Read its inline styles for exact values; the lean-gauge SVG math lives in its script (`pt()` / `gauge()` functions) and matches the "Lean Gauge Component" section above.
