import { createAccessOutcomeState } from "./access-outcome-state.js";
import { createBikeFrameCalibrationCapture } from "./core/bike-frame.js";
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
import { REPLAY_INITIALIZATION_ACTION } from "./core/raw-sensor-log.js";
import { exportRawSensorLog, createRawSensorRecorder } from "./core/recorder.js";
import {
  createRawLogExportState,
  RAW_LOG_EXPORT_STATUS,
} from "./core/raw-log-export-state.js";
import {
  adjustLapBoundaryIfAllowed,
  aggregateRunReport,
} from "./core/report.js";
import { createSessionRecorder } from "./core/session-recorder.js";
import {
  applyRunSaveOutcome,
  createRunStore,
  RUN_SAVE_STATUS,
} from "./core/run-store.js";
import {
  isRawRecorderExportEnabled,
  selectSensorSource,
} from "./dev/dev-sensor-source.js";
import { shouldMoveFocus, STATES, transition } from "./router.js";
import { shouldDestroySensorsOnPageHide } from "./page-lifecycle.js";
import { registerServiceWorker } from "./register-service-worker.js";
import { createBrowserSensorSource, SENSOR_STATUS } from "./sensors/sensor-source.js";
import { createRaceWakeLock, WAKE_LOCK_STATE } from "./sensors/wake-lock.js";
import { createLeanGaugeRenderer } from "./ui/lean-gauge.js";
import { renderRunReport } from "./ui/run-report.js";

const screens = new Map(
  [...document.querySelectorAll("[data-screen]")].map((screen) => [
    screen.dataset.screen,
    screen,
  ]),
);

void registerServiceWorker().catch((error) => {
  console.warn("Offline installation is unavailable.", error);
});

const browserSensorSource = createBrowserSensorSource();
const selectedSensorSource = await selectSensorSource({
  search: window.location.search,
  browserSource: browserSensorSource,
});
const exportRawRecording = isRawRecorderExportEnabled(window.location.search);
const rawRecorder = exportRawRecording ? createRawSensorRecorder(selectedSensorSource) : null;
const rawLogExportState = rawRecorder
  ? createRawLogExportState({ exportLog: exportRawSensorLog })
  : null;
const sensorSource = rawRecorder ?? selectedSensorSource;
const replayInitialization = sensorSource.getReplayInitialization?.() ?? null;
const enableButton = document.querySelector('[data-action="enable"]');
const accessOutcomeState = createAccessOutcomeState();
const monotonicNow = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now;
const gpsSpeedometer = createGpsSpeedometer({ nowRef: monotonicNow });
const readySpeedValue = document.querySelector("[data-speed-value]");
const readyGpsWarning = document.querySelector("[data-gps-warning]");
const raceSpeedValue = document.querySelector("[data-race-speed-value]");
const raceGpsWarning = document.querySelector("[data-race-gps-warning]");
const wakeLockStatus = document.querySelector("[data-wake-lock-status]");
const raceTime = document.querySelector("[data-race-time]");
const lapNumber = document.querySelector("[data-lap-number]");
const lastLap = document.querySelector("[data-last-lap]");
const reportScreen = document.querySelector('[data-screen="report"]');
const saveButton = document.querySelector('[data-action="save-run"]');
const saveStatus = document.querySelector("[data-save-status]");
const rawExportStatus = document.querySelector("[data-raw-export-status]");
const retryRawExportButton = document.querySelector('[data-action="retry-raw-export"]');
const zeroButton = document.querySelector('[data-action="zero"]');
const calibrationStatus = document.querySelector("[data-calibration-status]");
const leanEstimator = assertLeanEstimator(createLeanEstimator({ nowRef: monotonicNow }));
const CALIBRATION_CAPTURE_MS = 1_000;
const calibrationCapture = createBikeFrameCalibrationCapture({
  nowRef: monotonicNow,
  captureMs: CALIBRATION_CAPTURE_MS,
});
const readyLeanGauge = createLeanGaugeRenderer(document.querySelector("[data-lean-instrument]"));
const raceLeanGauge = createLeanGaugeRenderer(document.querySelector("[data-race-lean-instrument]"));
const sessionRecorder = createSessionRecorder({ nowRef: monotonicNow });
const raceWakeLock = createRaceWakeLock();
const runStore = createRunStore();

function renderWakeLockStatus(state) {
  const messages = {
    [WAKE_LOCK_STATE.HELD]: "KEEP AWAKE ON",
    [WAKE_LOCK_STATE.UNSUPPORTED]: "KEEP AWAKE UNSUPPORTED · SET IOS AUTO-LOCK TO NEVER",
    [WAKE_LOCK_STATE.REJECTED]: "KEEP AWAKE OFF · REQUEST REJECTED · SET IOS AUTO-LOCK TO NEVER",
    [WAKE_LOCK_STATE.RELEASED]: "KEEP AWAKE OFF · REACQUIRING",
  };
  wakeLockStatus.dataset.state = state;
  wakeLockStatus.textContent = messages[state];
}

raceWakeLock.subscribe(renderWakeLockStatus);

function renderRawExportStatus({ status }) {
  if (!rawLogExportState || status === null) {
    rawExportStatus.hidden = true;
    retryRawExportButton.hidden = true;
    return;
  }
  const messages = {
    [RAW_LOG_EXPORT_STATUS.EXPORTING]: "RAW LOG EXPORTING…",
    [RAW_LOG_EXPORT_STATUS.CANCELLED]: "RAW LOG EXPORT CANCELLED · RETAINED",
    [RAW_LOG_EXPORT_STATUS.FAILED]: "RAW LOG EXPORT FAILED · RETAINED",
    [RAW_LOG_EXPORT_STATUS.EXPORTED]: "RAW LOG EXPORTED",
  };
  rawExportStatus.hidden = false;
  rawExportStatus.textContent = messages[status];
  retryRawExportButton.hidden = ![
    RAW_LOG_EXPORT_STATUS.CANCELLED,
    RAW_LOG_EXPORT_STATUS.FAILED,
  ].includes(status);
}

rawLogExportState?.subscribe(renderRawExportStatus);

function logRawExportFailure({ status, error }) {
  if (status === RAW_LOG_EXPORT_STATUS.FAILED) {
    console.error("Raw sensor export failed.", error);
  }
}

let currentState = "enable";
let lastGyroReceivedAt = null;
let motionGrantedAt = null;
let latestPosition = null;
let raceTiming = null;
let raceStartedAtUnixMs = null;
let completedSession = null;
let raceTimer = null;
let lastLapActivationAt = Number.NEGATIVE_INFINITY;
let runCount = 0;
let replayCalibrationInitializing = false;
let replayRaceStarting = false;
let calibrationCaptureActive = false;
let calibrationCaptureOutcome = null;
let calibrationCaptureDeadline = null;

const MINIMUM_LAP_ACTIVATION_INTERVAL_MS = 500;

function applyLapTrim(lapIndex, adjustmentMs) {
  if (currentState !== "report" || !completedSession) return;
  const report = adjustLapBoundaryIfAllowed(
    completedSession.report,
    lapIndex,
    adjustmentMs,
  );
  if (report === completedSession.report) return;
  completedSession = Object.freeze({ report, exported: false });
  saveStatus.textContent = "";
  renderRunReport(reportScreen, report, {
    onTrim: applyLapTrim,
    focusTrim: { lapIndex, adjustmentMs },
  });
}

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

function clearCalibrationCaptureDeadline() {
  if (calibrationCaptureDeadline === null) return;
  window.clearTimeout(calibrationCaptureDeadline);
  calibrationCaptureDeadline = null;
}

function updateCalibrationUi() {
  if (replayInitialization) {
    const withoutLean =
      replayInitialization.action.type === REPLAY_INITIALIZATION_ACTION.CONTINUE_WITHOUT_LEAN;
    zeroButton.disabled = replayCalibrationInitializing;
    zeroButton.textContent = replayCalibrationInitializing
      ? "INITIALIZING…"
      : withoutLean
        ? "CONTINUE WITHOUT LEAN"
        : "LOAD RECORDED ZERO";
    calibrationStatus.textContent = replayCalibrationInitializing
      ? "REPLAYING RECORDED PRE-ACTION STATE"
      : withoutLean
        ? "RECORDED NO-LEAN ACTION READY"
        : "RECORDED CALIBRATION READY";
    calibrationStatus.dataset.ready = String(!replayCalibrationInitializing);
    return;
  }
  const outcome = accessOutcomeState.getCurrent()?.motion;
  if (outcome?.status !== SENSOR_STATUS.GRANTED) return;
  const now = monotonicNow();
  const gyroTimedOut =
    Number.isFinite(motionGrantedAt) &&
    now - motionGrantedAt > 1_000 &&
    !isGyroDeliveryFresh(lastGyroReceivedAt, now);
  zeroButton.disabled = calibrationCaptureActive;
  zeroButton.textContent = calibrationCaptureActive ? "CAPTURING ZERO" : "ZERO NOW";
  calibrationStatus.textContent = calibrationCaptureActive
    ? "CAPTURING ZERO"
    : calibrationCaptureOutcome?.status === "cancelled"
      ? `ZERO NOT CAPTURED · ${calibrationCaptureOutcome.reason} · TRY AGAIN`
      : gyroTimedOut
        ? "GYROSCOPE NOT DELIVERING · TAP ZERO TO CONTINUE WITHOUT LEAN"
        : "HOLD BIKE UPRIGHT · TAP ZERO";
  calibrationStatus.dataset.ready = "false";
}

function finishCalibrationCapture(outcome) {
  if (!calibrationCaptureActive || outcome.status === "capturing") return;
  calibrationCaptureActive = false;
  clearCalibrationCaptureDeadline();

  if (outcome.status !== "captured") {
    calibrationCaptureOutcome = outcome;
    updateCalibrationUi();
    return;
  }

  try {
    leanEstimator.calibrate(outcome.gravity);
    rawRecorder?.setReplayCalibration(outcome.gravity);
    readyLeanGauge.render(0);
    dispatch("ZERO");
  } catch (error) {
    console.error("Bike-frame calibration failed.", error);
    calibrationCaptureOutcome = Object.freeze({ status: "cancelled", reason: "ADJUST PHONE MOUNT" });
    updateCalibrationUi();
  }
}

function currentLean(now = monotonicNow()) {
  const reading = leanEstimator.snapshot();
  return reading.calibrated && isGyroDeliveryFresh(lastGyroReceivedAt, now)
    ? reading.leanDegrees
    : null;
}

function liveSessionReading(now = monotonicNow()) {
  const speed = gpsSpeedometer.snapshot();
  return {
    position: latestPosition,
    speedMph: speed.hasSpeed ? speed.mph : null,
    speedValid: speed.hasSpeed && latestPosition !== null,
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
  let acceptedLocation = false;

  if (sample.type === "location") {
    gpsSpeedometer.handle(sample);
    const acceptedTimestamp = gpsSpeedometer.acceptedLocationTimestamp();
    acceptedLocation = isAcceptedLocationSample(sample, acceptedTimestamp);
    const kinematicSample = gpsSpeedometer.kinematicSample();
    latestPosition = positionForAcceptedLocation(sample, acceptedTimestamp, latestPosition);
    if (acceptedLocation) {
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
    const captureOutcome = calibrationCapture.add(sample, monotonicNow());
    if (calibrationCaptureActive && captureOutcome.status !== "capturing") {
      finishCalibrationCapture(captureOutcome);
    }
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
    calibrationCaptureActive = false;
    clearCalibrationCaptureDeadline();
    zeroButton.disabled = false;
    readyLeanGauge.render(Number.NaN);
    raceLeanGauge.render(Number.NaN);
  } else {
    updateCalibrationUi();
  }

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

zeroButton.addEventListener("click", async () => {
  const motionAvailable =
    accessOutcomeState.getCurrent()?.motion.status === SENSOR_STATUS.GRANTED;
  if (replayInitialization) {
    replayCalibrationInitializing = true;
    updateCalibrationUi();
    try {
      // Prime the same GPS/source state that existed when the recorded action
      // ran, then deterministically apply calibration or continue without lean.
      await sensorSource.initializeAction();
      if (replayInitialization.action.type === REPLAY_INITIALIZATION_ACTION.CALIBRATE) {
        leanEstimator.calibrate(replayInitialization.action.gravity);
        readyLeanGauge.render(0);
      } else {
        readyLeanGauge.render(Number.NaN);
      }
      replayCalibrationInitializing = false;
      dispatch("ZERO");
    } catch (error) {
      replayCalibrationInitializing = false;
      console.error("Replay initialization action failed.", error);
      zeroButton.disabled = false;
      updateCalibrationUi();
      calibrationStatus.textContent = "REPLAY INITIALIZATION FAILED";
      calibrationStatus.dataset.ready = "false";
    }
    return;
  }
  if (motionAvailable) {
    const now = monotonicNow();
    const gyroTimedOut =
      Number.isFinite(motionGrantedAt) &&
      now - motionGrantedAt > 1_000 &&
      !isGyroDeliveryFresh(lastGyroReceivedAt, now);
    if (gyroTimedOut) {
      rawRecorder?.setReplayWithoutLean();
      readyLeanGauge.render(Number.NaN);
      dispatch("ZERO");
      return;
    }

    calibrationCaptureActive = true;
    calibrationCaptureOutcome = null;
    calibrationCapture.start(now);
    updateCalibrationUi();
    calibrationCaptureDeadline = window.setTimeout(() => {
      finishCalibrationCapture(calibrationCapture.snapshot(monotonicNow()));
    }, CALIBRATION_CAPTURE_MS + 1);
    return;
  } else {
    rawRecorder?.setReplayWithoutLean();
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

document.querySelector('[data-action="start-race"]').addEventListener("click", async () => {
  if (currentState !== "ready" || replayRaceStarting) return;
  if (!discardPendingRawLogForReplacement()) return;
  if (replayInitialization) {
    replayRaceStarting = true;
    try {
      // Rebuild the exact post-action estimator state immediately before Race so
      // user dwell time on Ready cannot make replayed GPS/gyro state stale.
      await sensorSource.initializeReplay();
    } catch (error) {
      console.error("Replay initialization failed.", error);
      replayRaceStarting = false;
      return;
    }
    replayRaceStarting = false;
    if (currentState !== "ready") return;
  }
  const now = monotonicNow();
  lastLapActivationAt = now;
  raceTiming = startLapTiming(now);
  raceStartedAtUnixMs = Date.now();
  runCount += 1;
  completedSession = null;
  lapNumber.textContent = "1";
  lastLap.textContent = "--:--.-";
  raceTime.textContent = "00:00.0";
  sessionRecorder.start(now);
  sessionRecorder.record(liveSessionReading(now), now, { force: true });
  rawRecorder?.startRecording();
  dispatch("START_RACE");
  sensorSource.startReplay?.();
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
    {
      runNumber: runCount,
      runId: null,
      riderId: null,
      startedAtUnixMs: raceStartedAtUnixMs,
      endedAtUnixMs: raceStartedAtUnixMs + (now - raceTiming.sessionStartTime),
    },
  );
  completedSession = Object.freeze({ report, exported: false });
  saveStatus.textContent = "";
  delete reportScreen.dataset.expandedLap;
  delete reportScreen.dataset.trackMode;
  renderRunReport(reportScreen, report, { onTrim: applyLapTrim });
  stopRaceTimer();
  void raceWakeLock.stop();

  if (rawRecorder) {
    const rawLog = rawRecorder.stopRecording();
    void rawLogExportState.begin(rawLog).then(logRawExportFailure);
  }
  dispatch("END_RACE");
});

function discardPendingRawLogForReplacement() {
  if (!rawLogExportState?.hasPending()) return true;
  if (!window.confirm("A raw recorder log has not been exported. Discard it and start a new run?")) {
    return false;
  }
  rawLogExportState.discard();
  return true;
}

document.querySelector('[data-action="new-run"]').addEventListener("click", () => {
  if (
    completedSession &&
    !completedSession.exported &&
    !window.confirm("This run has not been exported. Discard it and start a new run?")
  ) {
    return;
  }
  if (!discardPendingRawLogForReplacement()) return;
  raceTiming = null;
  raceStartedAtUnixMs = null;
  completedSession = null;
  delete reportScreen.dataset.expandedLap;
  delete reportScreen.dataset.trackMode;
  dispatch("NEW_RUN");
});

retryRawExportButton.addEventListener("click", () => {
  const retry = rawLogExportState?.retry();
  if (retry) void retry.then(logRawExportFailure);
});

saveButton.addEventListener("click", async () => {
  if (currentState !== "report" || !completedSession) return;
  const sessionBeingSaved = completedSession;
  saveButton.disabled = true;
  saveStatus.textContent = "PREPARING EXPORT…";
  try {
    const outcome = await runStore.save(sessionBeingSaved.report);
    if (completedSession !== sessionBeingSaved) return;
    completedSession = applyRunSaveOutcome(completedSession, sessionBeingSaved, outcome);
    if (outcome.status === RUN_SAVE_STATUS.EXPORTED) {
      saveStatus.textContent = "RUN EXPORTED";
    } else {
      saveStatus.textContent = "EXPORT CANCELLED · RUN RETAINED";
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

window.addEventListener("beforeunload", (event) => {
  if (!rawLogExportState?.hasPending()) return;
  event.preventDefault();
  event.returnValue = "";
});

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
