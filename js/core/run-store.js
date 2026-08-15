import { cloneJsonValue } from "./json-value.js";

export const RUN_EXPORT_FORMAT = "trackmaster.run";
export const RUN_EXPORT_SCHEMA_VERSION = 1;
export const RUN_SAVE_STATUS = Object.freeze({
  EXPORTED: "exported",
  CANCELLED: "cancelled",
});

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function normalizeGpxLongitude(longitude) {
  return longitude === 180 ? -180 : longitude;
}

/** Converts finite coordinates to the non-exponent lexical form required by xsd:decimal. */
function decimalText(value) {
  if (!Number.isFinite(value)) throw new TypeError("GPX coordinates must be finite.");
  if (Object.is(value, -0)) return "0";
  const text = String(value);
  if (!/[eE]/.test(text)) return text;

  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  let expanded;
  if (decimalIndex <= 0) {
    expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }
  return negative ? `-${expanded}` : expanded;
}

function validUnixTimestamp(value) {
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function isoTimestamp(value) {
  return validUnixTimestamp(value) ? new Date(value).toISOString() : null;
}

function exportClock(report, exportedAtMs) {
  const endedAtUnixMs = validUnixTimestamp(report.endedAtUnixMs)
    ? report.endedAtUnixMs
    : exportedAtMs;
  const startedAtUnixMs = validUnixTimestamp(report.startedAtUnixMs)
    ? report.startedAtUnixMs
    : endedAtUnixMs - report.totalDurationMs;
  return { startedAtUnixMs, endedAtUnixMs };
}

function exportSample(sample, clock, report) {
  const copy = cloneJsonValue(sample, "Run sample");
  const recordedAtMs = clock.startedAtUnixMs + (sample.timestamp - report.startedAt);
  return {
    ...copy,
    recordedAt: isoTimestamp(recordedAtMs),
    locationRecordedAt: isoTimestamp(sample.locationTimestamp),
  };
}

/** Builds a detached, complete versioned document without retaining report references. */
export function createRunExportDocument(report, { nowRef = Date.now } = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("RunStore.save requires a run report.");
  }
  if (typeof nowRef !== "function") throw new TypeError("Run export requires a clock.");
  if (!Array.isArray(report.samples) || !Array.isArray(report.laps) || !report.stats) {
    throw new TypeError("Run export requires a complete report with laps, stats, and samples.");
  }
  if (!Number.isFinite(report.startedAt) || !Number.isFinite(report.endedAt) ||
      !Number.isFinite(report.totalDurationMs)) {
    throw new TypeError("Run export requires finite session boundaries.");
  }

  const exportedAtMs = nowRef();
  if (!validUnixTimestamp(exportedAtMs)) throw new RangeError("Run export clock is invalid.");
  const clock = exportClock(report, exportedAtMs);
  const run = cloneJsonValue(report, "Run report");
  run.startedAtUnixMs = clock.startedAtUnixMs;
  run.endedAtUnixMs = clock.endedAtUnixMs;
  run.startedAtTimestamp = isoTimestamp(clock.startedAtUnixMs);
  run.endedAtTimestamp = isoTimestamp(clock.endedAtUnixMs);
  run.samples = report.samples.map((sample) => exportSample(sample, clock, report));

  return {
    format: RUN_EXPORT_FORMAT,
    schemaVersion: RUN_EXPORT_SCHEMA_VERSION,
    exportedAt: isoTimestamp(exportedAtMs),
    // Identity fields are duplicated at the envelope for routing before a
    // consumer needs to understand the complete run body.
    runId: report.runId ?? null,
    riderId: report.riderId ?? null,
    run,
  };
}

export function serializeRunJson(report, options = {}) {
  return `${JSON.stringify(createRunExportDocument(report, options), null, 2)}\n`;
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function locationPoints(report, exportedAtMs) {
  const clock = exportClock(report, exportedAtMs);
  const points = [];
  let previousKey = null;
  for (const sample of report.samples) {
    if (!validCoordinate(sample.latitude, sample.longitude)) continue;
    const timestampMs = validUnixTimestamp(sample.locationTimestamp)
      ? sample.locationTimestamp
      : clock.startedAtUnixMs + (sample.timestamp - report.startedAt);
    const timestamp = isoTimestamp(timestampMs);
    if (timestamp === null) continue;

    // Instrument samples repeat the latest native GPS fix at 20 Hz. GPX should
    // contain each fix once, while retaining separate stationary fixes in time.
    const longitude = normalizeGpxLongitude(sample.longitude);
    const key = `${sample.latitude}|${longitude}|${timestamp}`;
    if (key === previousKey) continue;
    previousKey = key;
    points.push({ ...sample, longitude, timestamp });
  }
  return points;
}

/** Serializes valid GPX 1.1. A no-fix report is represented by an empty track. */
export function serializeRunGpx(report, {
  nowRef = Date.now,
  trackName = `TrackMaster Run ${report?.runNumber ?? ""}`.trim(),
} = {}) {
  if (!report || !Array.isArray(report.samples)) {
    throw new TypeError("GPX export requires a report sample series.");
  }
  const exportedAtMs = nowRef();
  if (!validUnixTimestamp(exportedAtMs)) throw new RangeError("GPX export clock is invalid.");
  const points = locationPoints(report, exportedAtMs);
  const rows = points.map((point) => {
    const extensions = [];
    if (Number.isFinite(point.speedMph)) {
      extensions.push(`<trackmaster:speedMph>${point.speedMph}</trackmaster:speedMph>`);
    }
    if (Number.isFinite(point.leanDegrees)) {
      extensions.push(`<trackmaster:leanDegrees>${point.leanDegrees}</trackmaster:leanDegrees>`);
    }
    const extensionXml = extensions.length === 0
      ? ""
      : `<extensions>${extensions.join("")}</extensions>`;
    return `      <trkpt lat="${decimalText(point.latitude)}" lon="${decimalText(point.longitude)}"><time>${point.timestamp}</time>${extensionXml}</trkpt>`;
  });
  const segment = rows.length === 0 ? "      " : `\n${rows.join("\n")}\n    `;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="TrackMaster" xmlns="http://www.topografix.com/GPX/1/1" xmlns:trackmaster="https://ribeck18.github.io/trackmaster/gpx/1">\n` +
    `  <trk><name>${escapeXml(trackName)}</name><trkseg>${segment}</trkseg></trk>\n` +
    `</gpx>\n`;
}

function utcStamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  const millisecond = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hour}${minute}${second}-${millisecond}`;
}

export function runExportFilenames(report, { date = new Date() } = {}) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Export filenames require a valid date.");
  }
  const runNumber = Number.isInteger(report?.runNumber) && report.runNumber > 0
    ? `-run-${report.runNumber}`
    : "";
  const base = `trackmaster-${utcStamp(date)}${runNumber}`;
  return Object.freeze({ json: `${base}.json`, gpx: `${base}.gpx` });
}

function createFile(contents, name, type, { FileRef, BlobRef }) {
  if (typeof FileRef === "function") return new FileRef([contents], name, { type });
  if (typeof BlobRef !== "function") throw new Error("File export is unavailable in this browser.");
  const blob = new BlobRef([contents], { type });
  Object.defineProperty(blob, "name", { value: name, enumerable: true });
  return blob;
}

export function createRunExportFiles(report, {
  nowRef = Date.now,
  FileRef = globalThis.File,
  BlobRef = globalThis.Blob,
} = {}) {
  const exportedAtMs = nowRef();
  const fixedNow = () => exportedAtMs;
  const names = runExportFilenames(report, { date: new Date(exportedAtMs) });
  const files = [createFile(
    serializeRunJson(report, { nowRef: fixedNow }),
    names.json,
    "application/json",
    { FileRef, BlobRef },
  )];
  if (report.samples.some((sample) => validCoordinate(sample.latitude, sample.longitude))) {
    files.push(createFile(
      serializeRunGpx(report, { nowRef: fixedNow }),
      names.gpx,
      "application/gpx+xml",
      { FileRef, BlobRef },
    ));
  }
  return Object.freeze(files);
}

export function isShareCancellation(error) {
  return error?.name === "AbortError" || error?.code === 20;
}

function canShareFiles(navigatorRef, payload) {
  if (typeof navigatorRef?.share !== "function" || typeof navigatorRef?.canShare !== "function") {
    return false;
  }
  try {
    return navigatorRef.canShare(payload) === true;
  } catch {
    return false;
  }
}

function requireDownloadSupport(documentRef, URLRef) {
  if (!documentRef?.createElement || !documentRef.body?.append ||
      typeof URLRef?.createObjectURL !== "function" ||
      typeof URLRef?.revokeObjectURL !== "function") {
    throw new Error("File download is unavailable in this browser.");
  }
}

function downloadFiles(files, { documentRef, URLRef, setTimeoutRef }) {
  requireDownloadSupport(documentRef, URLRef);
  const urls = [];
  let anchor = null;
  let completed = false;
  try {
    anchor = documentRef.createElement("a");
    if (!anchor || typeof anchor.click !== "function") {
      throw new Error("File download is unavailable in this browser.");
    }
    anchor.hidden = true;
    documentRef.body.append(anchor);
    for (const file of files) {
      const url = URLRef.createObjectURL(file);
      urls.push(url);
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
    }
    completed = true;
  } finally {
    anchor?.remove?.();
    for (const url of urls) {
      if (!completed) {
        URLRef.revokeObjectURL(url);
        continue;
      }
      try {
        setTimeoutRef(() => URLRef.revokeObjectURL(url), 0);
      } catch {
        URLRef.revokeObjectURL(url);
      }
    }
  }
}

/** The single stateless save seam used by the report UI. */
export function createRunStore({
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
  URLRef = globalThis.URL,
  setTimeoutRef = globalThis.setTimeout,
  nowRef = Date.now,
  FileRef = globalThis.File,
  BlobRef = globalThis.Blob,
} = {}) {
  return Object.freeze({
    async save(report) {
      const files = createRunExportFiles(report, { nowRef, FileRef, BlobRef });
      const payload = { files: [...files], title: `TrackMaster Run ${report.runNumber}` };
      if (canShareFiles(navigatorRef, payload)) {
        try {
          await navigatorRef.share(payload);
          return Object.freeze({ status: RUN_SAVE_STATUS.EXPORTED, method: "share" });
        } catch (error) {
          if (isShareCancellation(error)) {
            return Object.freeze({ status: RUN_SAVE_STATUS.CANCELLED, method: "share" });
          }
          throw error;
        }
      }

      downloadFiles(files, { documentRef, URLRef, setTimeoutRef });
      return Object.freeze({ status: RUN_SAVE_STATUS.EXPORTED, method: "download" });
    },
  });
}

/** Prevents a completed save from changing a replacement or retimmed report. */
export function applyRunSaveOutcome(currentSession, sessionBeingSaved, outcome) {
  if (currentSession !== sessionBeingSaved || outcome?.status !== RUN_SAVE_STATUS.EXPORTED) {
    return currentSession;
  }
  return Object.freeze({ ...sessionBeingSaved, exported: true });
}
