import { createSyntheticSensorSource } from "./simulator.js";
import { loadReplaySensorSource } from "./replay.js";

export const DEV_SENSOR_PARAMETER = "dev-sensors";

export function readDevSensorOptions(search = "") {
  const parameters = new URLSearchParams(search);
  const mode = parameters.get(DEV_SENSOR_PARAMETER);
  if (mode !== "simulator" && mode !== "replay") {
    return Object.freeze({ mode: null, playbackRate: 1, replayLogUrl: null });
  }

  const requestedRate = Number(parameters.get("dev-rate") ?? 1);
  const playbackRate = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : 1;
  return Object.freeze({
    mode,
    playbackRate,
    replayLogUrl: parameters.get("replay-log"),
  });
}

/**
 * URL-only developer selection. Normal navigation has no control or route that
 * calls this branch and receives the untouched browser source.
 */
export async function selectSensorSource({
  search = "",
  browserSource,
  fetchRef = globalThis.fetch,
  simulatorOptions = {},
  replayOptions = {},
} = {}) {
  const options = readDevSensorOptions(search);
  if (options.mode === "simulator") {
    return createSyntheticSensorSource({
      playbackRate: options.playbackRate,
      ...simulatorOptions,
    });
  }
  if (options.mode === "replay") {
    if (!options.replayLogUrl) throw new Error("Replay mode requires a replay-log URL.");
    if (typeof fetchRef !== "function") throw new Error("Replay loading is unavailable.");
    const response = await fetchRef(options.replayLogUrl);
    if (!response.ok) throw new Error(`Replay log load failed (${response.status}).`);
    return loadReplaySensorSource(await response.text(), {
      playbackRate: options.playbackRate,
      ...replayOptions,
    });
  }
  return browserSource;
}

export function isRawRecorderExportEnabled(search = "") {
  return new URLSearchParams(search).get("dev-recorder") === "1";
}
