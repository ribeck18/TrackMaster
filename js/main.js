import { createAccessOutcomeState } from "./access-outcome-state.js";
import { createBikeFrameCalibrationWindow } from "./core/bike-frame.js";
import {
  createGpsSpeedometer,
  isAcceptedLocationSample,
  positionForAcceptedLocation,
} from "./core/gps-speed.js";
import {
  assertLeanEstimator,
  createLeanEstimator,
  isGyroDeliveryFresh,
} from "./core/lean-estimator.js";
import {
  completeLap,
  currentLapElapsed,
  endLapTiming,
  formatLapTime,
  startLapTiming,
} from "./core/lap-timing.js";
import { exportRawSensorLog, createRawSensorRecorder } from "./core/recorder.js";
import { aggregateRunReport, MAX_VALID_SPEED_INTERVAL_MS } from "./core/report.js";
import { createSessionRecorder } from "./core/session-recorder.js";
import {
  isRawRecorderExportEnabled,
  selectSensorSource,
} from "./dev/dev-sensor-source.js";
import { shouldMoveFocus, STATES, transition } from "./router.js";
import { shouldDestroySensorsOnPageHide } from "./page-lifecycle.js";
import { createBrowserSensorSource, SENSOR_STATUS } from "./sensors/sensor-source.js";
import { calculateBubbleOffset } from "./sensors/spirit-level.js";
import { createRaceWakeLock } from "./sensors/wake-lock.js";
import { createLeanGaugeRenderer } from "./ui/lean-gauge.js";
import { renderRunReport } from "./ui/run-report.js";

const screens = new Map(
  [...document.querySelectorAll("[data-screen]")].map((screen) => [
    screen.dataset.screen,
    screen,
  ]),
);

const browserSensorSource = createBrowserSensorSource();
const selectedSensorSource = await selectSensorSource({
  search: window.location.search,
  browserSource: browserSensorSource,
});
const exportRawRecording = isRawRecorderExportEnabled(window.location.search);
const rawRecorder = exportRawRecording ? createRawSensorRecorder(selectedSensorSource) : null;
const sensorSource = rawRecorder ?? selectedSensorSource;
const spiritLevel = document.querySelector("[data-spirit-level]");
const bubble = spiritLevel.querySelector(".level__bubble");
const unavailableLevel = spiritLevel.querySelector(".level__unavailable");
const enableButton = document.querySelector('[data-action="enable"]');
const accessOutcomeState = createAccessOutcomeState();
const gpsSpeedometer = createGpsSpeedometer();
const readySpeedValue = document.querySelector("[data-speed-value]");
const readyGpsWarning = document.querySelector("[data-gps-warning]");
const raceSpeedValue = document.querySelector("[data-race-speed-value]");
const raceGpsWarning = document.querySelector("[data-race-gps-warning]");
const raceTime = document.querySelector("[data-race-time]");
const lapNumber = document.querySelector("[data-lap-number]");
const lastLap = document.querySelector("[data-last-lap]");
const reportScreen = document.querySelector('[data-screen="report"]');
const saveButton = document.querySelector('[data-action="save-run"]');
const saveStatus = document.querySelector("[data-save-status]");
const zeroButton = document.querySelector('[data-action="zero"]');
const calibrationStatus = document.querySelector("[data-calibration-status]");
const monotonicNow = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now;
const leanEstimator = assertLeanEstimator(createLeanEstimator({ nowRef: monotonicNow }));
const calibrationWindow = createBikeFrameCalibrationWindow({ nowRef: monotonicNow });
const readyLeanGauge = createLeanGaugeRenderer(document.querySelector("[data-lean-instrument]"));
const raceLeanGauge = createLeanGaugeRenderer(document.querySelector("[data-race-lean-instrument]"));
const sessionRecorder = createSessionRecorder({ nowRef: monotonicNow });
const raceWakeLock = createRaceWakeLock();
// Issue #11 replaces this one-method seam with JSON/GPX sharing. Returning true
// is the only signal that NEW RUN may discard without confirmation.
const runStore = Object.freeze({
  async save(_report) {
    return false;
  },
});

let currentState = "enable";
let lastGyroReceivedAt = null;
let motionGrantedAt = null;
let latestPosition = null;
let lastValidSpeedReceivedAt = null;
let raceTiming = null;
let completedSession = null;
let raceTimer = null;
let lastLapActivationAt = Number.NEGATIVE_INFINITY;
let runCount = 0;

const MINIMUM_LAP_ACTIVATION_INTERVAL_MS = 500;

function render(nextState, { moveFocus = true } = {}) {
  currentState = nextState;

  for (const state of STATES) {
    const screen = screens.get(state);
    if (!screen) {
      throw new Error(`Missing screen markup for state: ${state}`);
    }

    const isActive = state === currentState;
    screen.hidden = !isActive;
    screen.setAttribute("aria-hidden", String(!isActive));
  }

  if (moveFocus) {
    screens.get(currentState)?.querySelector("h1")?.focus({ preventScroll: true });
  }
}

function dispatch(event) {
  const nextState = transition(currentState, event);
  render(nextState, { moveFocus: shouldMoveFocus(currentState, nextState) });
}

function displayRotation() {
  if (window.matchMedia?.("(orientation: portrait)").matches) return 90;
  const angle = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0);
  return Number.isFinite(angle) ? angle : 0;
}

function updateSpiritLevel(sample) {
  if (sample.type !== "orientation") return;
  const offset = calculateBubbleOffset(sample, { rotationDegrees: displayRotation() });
  if (!offset) return;

  bubble.style.setProperty("--bubble-x", `${offset.x.toFixed(2)}px`);
  bubble.style.setProperty("--bubble-y", `${offset.y.toFixed(2)}px`);
}

function updateCalibrationUi() {
  const outcome = accessOutcomeState.getCurrent()?.motion;
  if (outcome?.status !== SENSOR_STATUS.GRANTED) return;
  const now = monotonicNow();
  const readiness = calibrationWindow.snapshot(now);
  const gyroFresh = isGyroDeliveryFresh(lastGyroReceivedAt, now);
  const gyroTimedOut =
    Number.isFinite(motionGrantedAt) && now - motionGrantedAt > 1_000 && !gyroFresh;
  zeroButton.disabled = !readiness.ready && !gyroTimedOut;
  zeroButton.textContent = readiness.ready
    ? "ZERO NOW"
    : gyroTimedOut
      ? "CONTINUE WITHOUT LEAN"
      : "WAITING…";
  calibrationStatus.textContent = gyroTimedOut ? "GYROSCOPE NOT DELIVERING" : readiness.reason;
  calibrationStatus.dataset.ready = String(readiness.ready);
}

function currentLean(now = monotonicNow()) {
  const reading = leanEstimator.snapshot();
  return reading.calibrated && isGyroDeliveryFresh(lastGyroReceivedAt, now)
    ? reading.leanDegrees
    : null;
}

function liveSessionReading(now = monotonicNow()) {
  const speed = gpsSpeedometer.snapshot();
  const speedAge = now - lastValidSpeedReceivedAt;
  const speedValid =
    speed.hasSpeed &&
    latestPosition !== null &&
    Number.isFinite(lastValidSpeedReceivedAt) &&
    speedAge >= 0 &&
    speedAge <= MAX_VALID_SPEED_INTERVAL_MS;
  return {
    position: latestPosition,
    speedMph: speed.hasSpeed ? speed.mph : null,
    speedValid,
    leanDegrees: currentLean(now),
  };
}

function captureSessionSample(sample, { acceptedLocation = false } = {}) {
  if (currentState !== "race" || !sessionRecorder.isRecording()) return;
  if (!["location", "motion", "orientation"].includes(sample.type)) return;
  if (sample.type === "location" && !acceptedLocation) return;
  const now = monotonicNow();
  sessionRecorder.record(liveSessionReading(now), now, { force: acceptedLocation });
}

function handleSensorSample(sample) {
  updateSpiritLevel(sample);
  let acceptedLocation = false;

  if (sample.type === "location") {
    gpsSpeedometer.handle(sample);
    const acceptedTimestamp = gpsSpeedometer.acceptedLocationTimestamp();
    acceptedLocation = isAcceptedLocationSample(sample, acceptedTimestamp);
    const kinematicSample = gpsSpeedometer.kinematicSample();
    latestPosition = positionForAcceptedLocation(sample, acceptedTimestamp, latestPosition);
    if (acceptedLocation) {
      if (Number.isFinite(kinematicSample?.speedMps) && kinematicSample.speedMps >= 0) {
        lastValidSpeedReceivedAt = monotonicNow();
      }
      leanEstimator.update(kinematicSample);
    }
  } else {
    gpsSpeedometer.handle(sample);
  }

  if (sample.type === "motion") {
    if (
      sample.rotationRate &&
      [sample.rotationRate.x, sample.rotationRate.y, sample.rotationRate.z].every(Number.isFinite)
    ) {
      lastGyroReceivedAt = monotonicNow();
    }
    calibrationWindow.add(sample, monotonicNow());
    if (currentState === "cal") updateCalibrationUi();
    leanEstimator.update(sample);
  }

  captureSessionSample(sample, { acceptedLocation });

  if (sample.type !== "access") return;
  const recoveredOutcomes = accessOutcomeState.record(sample.sensor, sample.outcome);
  if (!recoveredOutcomes) return;
  applyAccessOutcomes(recoveredOutcomes);

  const allGranted = Object.values(recoveredOutcomes).every(
    ({ status }) => status === SENSOR_STATUS.GRANTED,
  );
  if (currentState === "permission-denied" && allGranted) {
    dispatch("CONTINUE_LIMITED");
  }
}

sensorSource.subscribe(handleSensorSample);

function setGateStatus(sensor, status, label = status.toUpperCase()) {
  const element = document.querySelector(`[data-permission="${sensor}"]`);
  element.dataset.status = status;
  element.textContent = label;
}

function recoveryParagraph(text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  return paragraph;
}

function applyAccessOutcomes(outcomes) {
  if (outcomes.location.status !== SENSOR_STATUS.GRANTED) {
    latestPosition = null;
    lastValidSpeedReceivedAt = null;
    gpsSpeedometer.clearFix();
    leanEstimator.clearLocation();
  }

  const recovery = document.querySelector("[data-recovery-guidance]");
  recovery.replaceChildren();

  for (const sensor of ["motion", "location"]) {
    const { status } = outcomes[sensor];
    setGateStatus(sensor, status);

    const resultOutput = document.querySelector(`[data-result="${sensor}"]`);
    resultOutput.dataset.status = status;
    resultOutput.textContent = status.toUpperCase();

    for (const readout of document.querySelectorAll(`[data-readout="${sensor}"]`)) {
      readout.dataset.status = status;
      readout.textContent = status === SENSOR_STATUS.GRANTED ? "GRANTED" : "N/A";
    }
  }

  if (outcomes.motion.status === SENSOR_STATUS.DENIED) {
    recovery.append(
      recoveryParagraph(
        "Motion was denied. This page cannot re-prompt. Recover in iOS Settings → Safari → Motion & Orientation Access, then reload Apex.",
      ),
    );
  } else if (outcomes.motion.status === SENSOR_STATUS.UNSUPPORTED) {
    recovery.append(recoveryParagraph("Motion is unsupported on this device or browser; lean will show N/A."));
  }

  if (outcomes.location.status === SENSOR_STATUS.DENIED) {
    recovery.append(
      recoveryParagraph(
        "Location was denied. This page cannot re-prompt. Recover in iOS Settings → Privacy & Security → Location Services → Safari Websites → While Using the App, then reload Apex.",
      ),
    );
  } else if (outcomes.location.status === SENSOR_STATUS.UNAVAILABLE) {
    recovery.append(
      recoveryParagraph(
        "Location is temporarily unavailable. GPS is still acquiring and will recover automatically when a fix arrives.",
      ),
    );
  } else if (outcomes.location.status === SENSOR_STATUS.UNSUPPORTED) {
    recovery.append(recoveryParagraph("Location is unsupported on this device or browser; speed will show N/A."));
  }

  const motionAvailable = outcomes.motion.status === SENSOR_STATUS.GRANTED;
  if (motionAvailable && motionGrantedAt === null) motionGrantedAt = monotonicNow();
  if (!motionAvailable) {
    motionGrantedAt = null;
    calibrationWindow.reset();
    zeroButton.disabled = false;
    readyLeanGauge.render(Number.NaN);
    raceLeanGauge.render(Number.NaN);
  } else {
    updateCalibrationUi();
  }
  spiritLevel.classList.toggle("level--unavailable", !motionAvailable);
  spiritLevel.setAttribute(
    "aria-label",
    motionAvailable ? "Live spirit level" : "Spirit level unavailable because motion access is unavailable",
  );
  unavailableLevel.hidden = motionAvailable;

  if (!motionAvailable) {
    zeroButton.textContent = "CONTINUE";
    calibrationStatus.textContent = "LEAN SENSOR UNAVAILABLE";
    calibrationStatus.dataset.ready = "false";
  }
}

enableButton.addEventListener("click", async () => {
  enableButton.disabled = true;
  enableButton.textContent = "REQUESTING…";
  setGateStatus("motion", "requesting", "REQUESTING…");
  setGateStatus("location", "requesting", "REQUESTING…");

  try {
    // requestAccess synchronously starts both platform permission flows before
    // its returned promise is awaited, keeping them inside this user gesture.
    const initialOutcomes = await sensorSource.requestAccess();
    const mergedOutcomes = accessOutcomeState.initialize(initialOutcomes);
    applyAccessOutcomes(mergedOutcomes);

    const allGranted = Object.values(mergedOutcomes).every(
      ({ status }) => status === SENSOR_STATUS.GRANTED,
    );
    dispatch(allGranted ? "ENABLE" : "PERMISSION_DENIED");
  } catch {
    const unavailable = Object.freeze({ status: SENSOR_STATUS.UNSUPPORTED, reason: "Access failed." });
    const mergedOutcomes = accessOutcomeState.initialize({
      motion: unavailable,
      location: unavailable,
    });
    applyAccessOutcomes(mergedOutcomes);
    dispatch("PERMISSION_DENIED");
  } finally {
    enableButton.textContent = "ENABLE SENSORS";
  }
});

zeroButton.addEventListener("click", () => {
  const motionAvailable =
    accessOutcomeState.getCurrent()?.motion.status === SENSOR_STATUS.GRANTED;
  if (motionAvailable) {
    const now = monotonicNow();
    const readiness = calibrationWindow.snapshot(now);
    if (!readiness.ready) {
      const gyroTimedOut =
        Number.isFinite(motionGrantedAt) &&
        now - motionGrantedAt > 1_000 &&
        !isGyroDeliveryFresh(lastGyroReceivedAt, now);
      if (gyroTimedOut) {
        readyLeanGauge.render(Number.NaN);
        dispatch("ZERO");
        return;
      }
      updateCalibrationUi();
      return;
    }
    try {
      leanEstimator.calibrate(readiness.gravity);
      readyLeanGauge.render(0);
    } catch (error) {
      console.error("Bike-frame calibration failed.", error);
      calibrationWindow.reset();
      updateCalibrationUi();
      return;
    }
  } else {
    readyLeanGauge.render(Number.NaN);
  }
  dispatch("ZERO");
});

function renderRaceTimer() {
  if (currentState !== "race" || !raceTiming) return;
  const elapsed = currentLapElapsed(raceTiming, monotonicNow());
  const formatted = formatLapTime(elapsed);
  if (raceTime.textContent !== formatted) raceTime.textContent = formatted;
  raceTime.setAttribute("aria-label", `Current lap time ${formatted}`);
}

function startRaceTimer() {
  if (raceTimer !== null) window.clearInterval(raceTimer);
  raceTimer = window.setInterval(renderRaceTimer, 100);
  renderRaceTimer();
}

function stopRaceTimer() {
  if (raceTimer === null) return;
  window.clearInterval(raceTimer);
  raceTimer = null;
}

function acceptLapActivation(now) {
  if (now - lastLapActivationAt < MINIMUM_LAP_ACTIVATION_INTERVAL_MS) return false;
  lastLapActivationAt = now;
  return true;
}

document.querySelector('[data-action="start-race"]').addEventListener("click", () => {
  if (currentState !== "ready") return;
  const now = monotonicNow();
  lastLapActivationAt = now;
  raceTiming = startLapTiming(now);
  runCount += 1;
  completedSession = null;
  lapNumber.textContent = "1";
  lastLap.textContent = "--:--.-";
  raceTime.textContent = "00:00.0";
  sessionRecorder.start(now);
  sessionRecorder.record(liveSessionReading(now), now, { force: true });
  rawRecorder?.startRecording();
  dispatch("START_RACE");
  startRaceTimer();
  void raceWakeLock.start();
});

document.querySelector('[data-action="complete-lap"]').addEventListener("click", () => {
  if (currentState !== "race" || !raceTiming) return;
  const now = monotonicNow();
  // A second tap from a Ready-screen double-tap must not create a near-zero lap.
  if (!acceptLapActivation(now)) return;
  raceTiming = completeLap(raceTiming, now);
  const completedLap = raceTiming.laps.at(-1);
  lapNumber.textContent = String(raceTiming.lapNumber);
  lastLap.textContent = formatLapTime(completedLap.duration);
  raceTime.textContent = "00:00.0";
  dispatch("NEXT_LAP");
});

document.querySelector('[data-action="end-race"]').addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (currentState !== "race" || !raceTiming) return;

  const now = monotonicNow();
  raceTiming = endLapTiming(raceTiming, now);
  sessionRecorder.record(liveSessionReading(now), now, { force: true });
  const recordedSession = sessionRecorder.stop(now);
  const report = aggregateRunReport(
    { timing: raceTiming, samples: recordedSession.samples },
    { runNumber: runCount, runId: null, riderId: null },
  );
  completedSession = Object.freeze({ report, exported: false });
  renderRunReport(reportScreen, report);
  stopRaceTimer();
  void raceWakeLock.stop();

  if (rawRecorder) {
    const rawLog = rawRecorder.stopRecording();
    void exportRawSensorLog(rawLog).catch((error) => console.error("Raw sensor export failed.", error));
  }
  dispatch("END_RACE");
});

document.querySelector('[data-action="new-run"]').addEventListener("click", () => {
  if (
    completedSession &&
    !completedSession.exported &&
    !window.confirm("This run has not been exported. Discard it and start a new run?")
  ) {
    return;
  }
  raceTiming = null;
  completedSession = null;
  dispatch("NEW_RUN");
});

saveButton.addEventListener("click", async () => {
  if (currentState !== "report" || !completedSession) return;
  const sessionBeingSaved = completedSession;
  saveButton.disabled = true;
  saveStatus.textContent = "PREPARING EXPORT…";
  try {
    const exported = await runStore.save(sessionBeingSaved.report);
    if (completedSession !== sessionBeingSaved) return;
    if (exported) {
      completedSession = Object.freeze({ ...sessionBeingSaved, exported: true });
      saveStatus.textContent = "RUN EXPORTED";
    } else {
      saveStatus.textContent = "EXPORT NOT AVAILABLE IN THIS BUILD";
    }
  } catch (error) {
    console.error("Run export failed.", error);
    if (completedSession === sessionBeingSaved) {
      saveStatus.textContent = "EXPORT FAILED · RUN RETAINED";
    }
  } finally {
    saveButton.disabled = false;
  }
});

document.querySelector('[data-action="continue-limited"]').addEventListener("click", () => {
  if (!accessOutcomeState.getCurrent()) return;
  dispatch("CONTINUE_LIMITED");
});

function renderSpeed(value, warning, reading) {
  const nextValue = reading.hasSpeed ? String(reading.mph) : "--";
  if (value.textContent !== nextValue) value.textContent = nextValue;
  value.setAttribute(
    "aria-label",
    reading.hasSpeed ? `Speed ${reading.mph} miles per hour` : "Speed unavailable",
  );
  if (warning.textContent !== reading.warning) warning.textContent = reading.warning;
  warning.classList.toggle("is-clear", reading.warning === "");
}

function renderInstruments() {
  const speedReading = gpsSpeedometer.snapshot();
  renderSpeed(readySpeedValue, readyGpsWarning, speedReading);
  renderSpeed(raceSpeedValue, raceGpsWarning, speedReading);

  const leanDegrees = currentLean();
  readyLeanGauge.render(leanDegrees ?? Number.NaN);
  raceLeanGauge.render(leanDegrees ?? Number.NaN);
  if (currentState === "cal") updateCalibrationUi();
}

// Instrument numerals are intentionally capped at 5 Hz even when a simulator,
// replay, or future browser source delivers fixes faster than the GPS radio.
const instrumentRenderTimer = window.setInterval(renderInstruments, 200);
renderInstruments();

window.addEventListener("pagehide", (event) => {
  // A persisted pagehide enters the back-forward cache; its live JS heap and
  // sensor source resume on pageshow, so destroying here would make the restored
  // UI permanently stale. Final navigations still release both platform watches.
  if (shouldDestroySensorsOnPageHide(event)) {
    window.clearInterval(instrumentRenderTimer);
    stopRaceTimer();
    void raceWakeLock.destroy();
    sensorSource.destroy();
  }
});

render(currentState, { moveFocus: false });
