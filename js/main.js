import { createAccessOutcomeState } from "./access-outcome-state.js";
import { createGpsSpeedometer } from "./core/gps-speed.js";
import { exportRawSensorLog, createRawSensorRecorder } from "./core/recorder.js";
import {
  isRawRecorderExportEnabled,
  selectSensorSource,
} from "./dev/dev-sensor-source.js";
import { STATES, transition } from "./router.js";
import { shouldDestroySensorsOnPageHide } from "./page-lifecycle.js";
import { createBrowserSensorSource, SENSOR_STATUS } from "./sensors/sensor-source.js";
import { calculateBubbleOffset } from "./sensors/spirit-level.js";

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
const speedValue = document.querySelector("[data-speed-value]");
const gpsWarning = document.querySelector("[data-gps-warning]");

let currentState = "enable";
let lap = 1;

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
  render(nextState);
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

function handleSensorSample(sample) {
  gpsSpeedometer.handle(sample);
  updateSpiritLevel(sample);

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
  if (outcomes.location.status !== SENSOR_STATUS.GRANTED) gpsSpeedometer.clearFix();

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
  spiritLevel.classList.toggle("level--unavailable", !motionAvailable);
  spiritLevel.setAttribute(
    "aria-label",
    motionAvailable ? "Live spirit level" : "Spirit level unavailable because motion access is unavailable",
  );
  unavailableLevel.hidden = motionAvailable;

  const zeroButton = document.querySelector('[data-action="zero"]');
  zeroButton.textContent = motionAvailable ? "ZERO NOW" : "CONTINUE";
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

document.querySelector('[data-action="zero"]').addEventListener("click", () => {
  dispatch("ZERO");
});

document.querySelector('[data-action="start-race"]').addEventListener("click", () => {
  lap = 1;
  document.querySelector("[data-lap-number]").textContent = String(lap);
  rawRecorder?.startRecording();
  dispatch("START_RACE");
});

document.querySelector('[data-action="complete-lap"]').addEventListener("click", () => {
  lap += 1;
  document.querySelector("[data-lap-number]").textContent = String(lap);
  dispatch("NEXT_LAP");
});

document.querySelector('[data-action="end-race"]').addEventListener("click", (event) => {
  event.stopPropagation();
  if (rawRecorder) {
    const rawLog = rawRecorder.stopRecording();
    void exportRawSensorLog(rawLog).catch((error) => console.error("Raw sensor export failed.", error));
  }
  dispatch("END_RACE");
});

document.querySelector('[data-action="new-run"]').addEventListener("click", () => {
  dispatch("NEW_RUN");
});

document.querySelector('[data-action="continue-limited"]').addEventListener("click", () => {
  if (!accessOutcomeState.getCurrent()) return;
  dispatch("CONTINUE_LIMITED");
});

function renderGpsSpeed() {
  const reading = gpsSpeedometer.snapshot();
  const nextValue = reading.hasSpeed ? String(reading.mph) : "--";
  if (speedValue.textContent !== nextValue) speedValue.textContent = nextValue;
  speedValue.setAttribute(
    "aria-label",
    reading.hasSpeed ? `Speed ${reading.mph} miles per hour` : "Speed unavailable",
  );
  if (gpsWarning.textContent !== reading.warning) gpsWarning.textContent = reading.warning;
  gpsWarning.classList.toggle("is-clear", reading.warning === "");
}

// Instrument numerals are intentionally capped at 5 Hz even when a simulator,
// replay, or future browser source delivers fixes faster than the GPS radio.
const speedRenderTimer = window.setInterval(renderGpsSpeed, 200);
renderGpsSpeed();

window.addEventListener("pagehide", (event) => {
  // A persisted pagehide enters the back-forward cache; its live JS heap and
  // sensor source resume on pageshow, so destroying here would make the restored
  // UI permanently stale. Final navigations still release both platform watches.
  if (shouldDestroySensorsOnPageHide(event)) {
    window.clearInterval(speedRenderTimer);
    sensorSource.destroy();
  }
});

render(currentState, { moveFocus: false });
