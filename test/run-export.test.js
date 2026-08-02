import test from "node:test";
import assert from "node:assert/strict";

import { adjustLapBoundary, aggregateRunReport } from "../js/core/report.js";
import {
  applyRunSaveOutcome,
  createRunExportDocument,
  createRunExportFiles,
  createRunStore,
  isShareCancellation,
  RUN_EXPORT_FORMAT,
  RUN_EXPORT_SCHEMA_VERSION,
  RUN_SAVE_STATUS,
  runExportFilenames,
  serializeRunGpx,
  serializeRunJson,
} from "../js/core/run-store.js";

const RUN_START = Date.parse("2026-08-01T12:00:00.000Z");
const EXPORT_TIME = Date.parse("2026-08-01T12:05:06.789Z");

function reportFixture({ location = true } = {}) {
  const timing = {
    sessionStartTime: 1_000,
    currentLapStartTime: 3_000,
    lapNumber: 2,
    laps: [{ index: 1, startTime: 1_000, endTime: 3_000, duration: 2_000 }],
    endedAt: 5_000,
  };
  const positioned = location
    ? { latitude: 37.42, longitude: -122.08, locationTimestamp: RUN_START + 1_000 }
    : {};
  return aggregateRunReport(
    {
      timing,
      samples: [
        { timestamp: 1_000, speedMph: location ? 40 : null, speedValid: location, leanDegrees: -12, ...positioned },
        {
          timestamp: 2_000,
          speedMph: location ? 80 : null,
          speedValid: location,
          leanDegrees: 34,
          ...(location ? {
            latitude: 37.421,
            longitude: -122.079,
            locationTimestamp: RUN_START + 2_000,
          } : {}),
        },
        { timestamp: 5_000, speedMph: null, speedValid: false, leanDegrees: 0 },
      ],
    },
    {
      runNumber: 7,
      runId: null,
      riderId: null,
      startedAtUnixMs: RUN_START,
      endedAtUnixMs: RUN_START + 4_000,
    },
  );
}

class FakeFile {
  constructor(parts, name, { type }) {
    this.parts = parts;
    this.name = name;
    this.type = type;
  }

  async text() {
    return this.parts.join("");
  }
}

function downloadHarness({ throwOnClick = null } = {}) {
  const clicks = [];
  const appended = [];
  const removed = [];
  const created = [];
  const revoked = [];
  const timers = [];
  let clickCount = 0;
  const anchor = {
    hidden: false,
    href: "",
    download: "",
    click() {
      clickCount += 1;
      if (clickCount === throwOnClick) throw new Error("click failed");
      clicks.push({ href: this.href, download: this.download });
    },
    remove() {
      removed.push(this);
    },
  };
  return {
    documentRef: {
      body: { append(node) { appended.push(node); } },
      createElement(name) {
        assert.equal(name, "a");
        return anchor;
      },
    },
    URLRef: {
      createObjectURL(file) {
        const url = `blob:${created.length + 1}`;
        created.push({ file, url });
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    setTimeoutRef(callback, delay) {
      timers.push({ callback, delay });
    },
    clicks,
    appended,
    removed,
    created,
    revoked,
    timers,
  };
}

test("JSON export is versioned, complete, timestamped, and detached", () => {
  const source = structuredClone(reportFixture());
  const document = createRunExportDocument(source, { nowRef: () => EXPORT_TIME });

  assert.equal(document.format, RUN_EXPORT_FORMAT);
  assert.equal(document.schemaVersion, RUN_EXPORT_SCHEMA_VERSION);
  assert.equal(document.runId, null);
  assert.equal(document.riderId, null);
  assert.equal(document.exportedAt, "2026-08-01T12:05:06.789Z");
  assert.equal(document.run.runNumber, 7);
  assert.deepEqual(document.run.stats, source.stats);
  assert.deepEqual(document.run.lapStats, source.lapStats);
  assert.deepEqual(document.run.location, source.location);
  assert.deepEqual(document.run.topSpeedPoint, source.topSpeedPoint);
  assert.equal(document.run.samples.length, source.samples.length);
  assert.equal(document.run.samples[1].recordedAt, "2026-08-01T12:00:01.000Z");
  assert.equal(document.run.samples[1].locationRecordedAt, "2026-08-01T12:00:02.000Z");

  source.stats.maxSpeedMph = 999;
  source.samples[0].latitude = 0;
  assert.notEqual(document.run.stats.maxSpeedMph, 999);
  assert.notEqual(document.run.samples[0].latitude, 0);
  assert.deepEqual(JSON.parse(serializeRunJson(reportFixture(), { nowRef: () => EXPORT_TIME })), document);
});

test("latest boundary trims and reassigned sample/lap stats are exported", () => {
  const trimmed = adjustLapBoundary(reportFixture(), 1, 100);
  const exported = createRunExportDocument(trimmed, { nowRef: () => EXPORT_TIME }).run;

  assert.deepEqual(exported.trim.originalBoundaries, [3_000]);
  assert.deepEqual(exported.trim.offsetsMs, [100]);
  assert.equal(exported.laps[0].endTime, 3_100);
  assert.equal(exported.laps[0].duration, 2_100);
  assert.equal(exported.unfinishedLap.startTime, 3_100);
  assert.deepEqual(exported.samples.map((sample) => sample.lap.index), [1, 1, 2]);
  assert.equal(exported.lapStats[0].sampleCount, 2);
});

test("GPX is escaped and preserves each native location fix timestamp once", () => {
  const report = structuredClone(reportFixture());
  report.samples.splice(1, 0, { ...report.samples[0] });
  const gpx = serializeRunGpx(report, {
    nowRef: () => EXPORT_TIME,
    trackName: `Run & <seven> "fast" 'safe'`,
  });

  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1"[^>]*xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.match(gpx, /<name>Run &amp; &lt;seven&gt; &quot;fast&quot; &apos;safe&apos;<\/name>/);
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 2, "a repeated 20 Hz reading does not duplicate a native fix");
  assert.match(gpx, /<time>2026-08-01T12:00:01\.000Z<\/time>/);
  assert.match(gpx, /<time>2026-08-01T12:00:02\.000Z<\/time>/);
  assert.match(gpx, /<trackmaster:speedMph>80<\/trackmaster:speedMph>/);
  assert.match(gpx, /<trackmaster:leanDegrees>34<\/trackmaster:leanDegrees>/);
  assert.match(gpx, /<\/trkseg><\/trk>\s*<\/gpx>\n$/);
});

test("GPX coordinates use schema-compatible decimal text and longitude range", () => {
  const report = structuredClone(reportFixture());
  report.samples = [
    {
      timestamp: 1_000,
      locationTimestamp: RUN_START,
      latitude: 1.23456789e-7,
      longitude: 180,
    },
    {
      timestamp: 2_000,
      locationTimestamp: RUN_START + 1_000,
      latitude: -1.23456789e-7,
      longitude: -180,
    },
    {
      timestamp: 3_000,
      locationTimestamp: RUN_START + 2_000,
      latitude: 45.123456789,
      longitude: -9.87654321e-7,
    },
    {
      timestamp: 4_000,
      locationTimestamp: RUN_START + 3_000,
      latitude: -45.123456789,
      longitude: 9.87654321e-7,
    },
    { timestamp: 4_500, locationTimestamp: RUN_START + 3_500, latitude: 90.0001, longitude: 0 },
    { timestamp: 4_600, locationTimestamp: RUN_START + 3_600, latitude: 0, longitude: 180.0001 },
  ];

  const gpx = serializeRunGpx(report, { nowRef: () => EXPORT_TIME });
  const coordinates = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)]
    .map((match) => ({ latitude: match[1], longitude: match[2] }));
  assert.deepEqual(coordinates, [
    { latitude: "0.000000123456789", longitude: "-180" },
    { latitude: "-0.000000123456789", longitude: "-180" },
    { latitude: "45.123456789", longitude: "-0.000000987654321" },
    { latitude: "-45.123456789", longitude: "0.000000987654321" },
  ]);

  // Equivalent to the GPX 1.1 latitudeType/longitudeType lexical and range
  // restrictions: xsd:decimal (no exponent), latitude inclusive ±90, and
  // longitude inclusive -180 but exclusive +180.
  const xsdDecimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  for (const coordinate of coordinates) {
    assert.match(coordinate.latitude, xsdDecimal);
    assert.match(coordinate.longitude, xsdDecimal);
    assert.ok(Number(coordinate.latitude) >= -90 && Number(coordinate.latitude) <= 90);
    assert.ok(Number(coordinate.longitude) >= -180 && Number(coordinate.longitude) < 180);
  }
  assert.doesNotMatch(gpx, /(?:lat|lon)="[^"]*[eE][^"]*"/);
  assert.equal(Number(coordinates[0].latitude), 1.23456789e-7, "tiny latitude precision is retained");
  assert.equal(Number(coordinates[2].longitude), -9.87654321e-7, "tiny longitude precision is retained");
});

test("no-location runs have valid JSON, valid empty GPX, and omit GPX from SAVE", async () => {
  const report = reportFixture({ location: false });
  const json = JSON.parse(serializeRunJson(report, { nowRef: () => EXPORT_TIME }));
  const gpx = serializeRunGpx(report, { nowRef: () => EXPORT_TIME });
  const files = createRunExportFiles(report, {
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });

  assert.equal(json.run.location.available, false);
  assert.equal(json.run.samples.length, 3);
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 0);
  assert.match(gpx, /<trkseg>\s*<\/trkseg>/);
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "application/json");
  assert.doesNotMatch(await files[0].text(), /undefined|NaN/);
});

test("filenames distinguish runs and timestamps within the same UTC day", () => {
  const date = new Date(EXPORT_TIME);
  const first = runExportFilenames({ runNumber: 1 }, { date });
  const second = runExportFilenames({ runNumber: 2 }, { date });
  const later = runExportFilenames({ runNumber: 1 }, { date: new Date(EXPORT_TIME + 1) });

  assert.equal(first.json, "trackmaster-20260801-120506-789-run-1.json");
  assert.equal(first.gpx, "trackmaster-20260801-120506-789-run-1.gpx");
  assert.notEqual(first.json, second.json);
  assert.notEqual(first.json, later.json);
});

test("SAVE uses share only after explicit multi-file capability confirmation", async () => {
  const shared = [];
  const harness = downloadHarness();
  const store = createRunStore({
    navigatorRef: {
      canShare(payload) {
        assert.equal(payload.files.length, 2);
        return true;
      },
      async share(payload) { shared.push(payload); },
    },
    ...harness,
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });
  const outcome = await store.save(reportFixture());

  assert.deepEqual(outcome, { status: RUN_SAVE_STATUS.EXPORTED, method: "share" });
  assert.equal(shared.length, 1);
  assert.equal(harness.clicks.length, 0);
  assert.deepEqual(shared[0].files.map(({ type }) => type), ["application/json", "application/gpx+xml"]);
});

test("share cancellation is distinct from failure and never starts a fallback", async () => {
  const harness = downloadHarness();
  const cancelledStore = createRunStore({
    navigatorRef: {
      canShare: () => true,
      share: async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); },
    },
    ...harness,
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });
  assert.deepEqual(await cancelledStore.save(reportFixture()), {
    status: RUN_SAVE_STATUS.CANCELLED,
    method: "share",
  });
  assert.equal(harness.clicks.length, 0);
  assert.equal(isShareCancellation({ name: "AbortError" }), true);

  const failedStore = createRunStore({
    navigatorRef: {
      canShare: () => true,
      share: async () => { throw new Error("platform failed"); },
    },
    ...downloadHarness(),
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });
  await assert.rejects(() => failedStore.save(reportFixture()), /platform failed/);
});

test("unsupported multi-file share falls back to both downloads and cleans every URL", async () => {
  const harness = downloadHarness();
  let shareCalls = 0;
  const store = createRunStore({
    navigatorRef: { async share() { shareCalls += 1; } },
    ...harness,
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });
  const outcome = await store.save(reportFixture());

  assert.deepEqual(outcome, { status: RUN_SAVE_STATUS.EXPORTED, method: "download" });
  assert.equal(shareCalls, 0, "share without canShare proof is not attempted");
  assert.deepEqual(harness.clicks.map(({ download }) => download), [
    "trackmaster-20260801-120506-789-run-7.json",
    "trackmaster-20260801-120506-789-run-7.gpx",
  ]);
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.revoked.length, 0);
  assert.ok(harness.timers.every(({ delay }) => delay === 0));
  harness.timers.forEach(({ callback }) => callback());
  assert.deepEqual(harness.revoked, ["blob:1", "blob:2"]);
});

test("failed download cleans created URLs and is not reported as exported", async () => {
  const harness = downloadHarness({ throwOnClick: 2 });
  const store = createRunStore({
    navigatorRef: { canShare: () => false, share: async () => {} },
    ...harness,
    nowRef: () => EXPORT_TIME,
    FileRef: FakeFile,
  });

  await assert.rejects(() => store.save(reportFixture()), /click failed/);
  assert.deepEqual(harness.revoked, ["blob:1", "blob:2"]);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.timers.length, 0);
});

test("only a genuine success may mark the exact saved session exported", () => {
  const report = reportFixture();
  const saving = Object.freeze({ report, exported: false });
  const replacement = Object.freeze({ report: reportFixture(), exported: false });
  const retimmed = Object.freeze({ report: adjustLapBoundary(report, 1, 100), exported: false });
  const success = { status: RUN_SAVE_STATUS.EXPORTED };
  const cancelled = { status: RUN_SAVE_STATUS.CANCELLED };

  const updated = applyRunSaveOutcome(saving, saving, success);
  assert.equal(updated.exported, true);
  assert.equal(applyRunSaveOutcome(saving, saving, cancelled), saving);
  assert.equal(applyRunSaveOutcome(replacement, saving, success), replacement);
  assert.equal(applyRunSaveOutcome(retimmed, saving, success), retimmed);
});

test("an older concurrent completion cannot export a report retimmed while SAVE awaits", async () => {
  const report = reportFixture();
  const saving = Object.freeze({ report, exported: false });
  let current = saving;
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const completion = pendingSave.then((outcome) => {
    current = applyRunSaveOutcome(current, saving, outcome);
  });

  current = Object.freeze({ report: adjustLapBoundary(report, 1, 100), exported: false });
  finishSave({ status: RUN_SAVE_STATUS.EXPORTED });
  await completion;

  assert.equal(current.report.trim.offsetsMs[0], 100);
  assert.equal(current.exported, false);
});
