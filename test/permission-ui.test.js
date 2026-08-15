import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const main = await readFile(new URL("../js/main.js", import.meta.url), "utf8");

for (const sensor of ["motion", "location"]) {
  test(`${sensor} has independent gate, result, and degraded readout UI`, () => {
    assert.match(html, new RegExp(`data-permission="${sensor}"`));
    assert.match(html, new RegExp(`data-result="${sensor}"`));
    assert.match(html, new RegExp(`data-readout="${sensor}"`));
    assert.match(main, new RegExp(`outcomes\\.${sensor}\\.status`));
  });
}

test("granted, denied, unavailable, and unsupported outcomes receive distinct visible labels", () => {
  assert.match(main, /resultOutput\.textContent = status\.toUpperCase\(\)/);
  assert.match(main, /status === SENSOR_STATUS\.GRANTED \? "GRANTED" : "N\/A"/);
  assert.match(main, /SENSOR_STATUS\.DENIED/);
  assert.match(main, /SENSOR_STATUS\.UNAVAILABLE/);
  assert.match(main, /SENSOR_STATUS\.UNSUPPORTED/);
});

test("location fixes are merged through the unified subscription before rendering", () => {
  assert.match(main, /sample\.type !== "access"/);
  assert.match(main, /accessOutcomeState\.record\(sample\.sensor, sample\.outcome\)/);
  assert.match(main, /accessOutcomeState\.initialize\(initialOutcomes\)/);
  assert.match(main, /applyAccessOutcomes\(mergedOutcomes\)/);
  assert.match(main, /recover automatically when a fix arrives/);
});

test("denial recovery names exact iOS paths and says the page cannot re-prompt", () => {
  assert.match(main, /This page cannot re-prompt/);
  assert.match(main, /Settings → Safari → Motion & Orientation Access/);
  assert.match(
    main,
    /Settings → Privacy & Security → Location Services → Safari Websites → While Using the App/,
  );
});

test("the app consumes both physical sensors through one subscription interface", () => {
  assert.equal((main.match(/createBrowserSensorSource\(\)/g) ?? []).length, 1);
  assert.equal((main.match(/sensorSource\.subscribe\(/g) ?? []).length, 1);
  assert.match(main, /sensorSource\.requestAccess\(\)/);
});

test("Calibrate guides an upright bike capture without a phone-level visual", async () => {
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(html, /ZERO LEAN SENSOR/);
  assert.match(html, /Hold the BIKE upright while zero is captured\./);
  assert.match(main, /ZERO NOT CAPTURED · \$\{calibrationCaptureOutcome\.reason\} · TRY AGAIN/);
  for (const source of [html, main, css, sw]) {
    assert.doesNotMatch(source, /spirit-level|data-spirit-level|level__|calculateBubbleOffset|--bubble-[xy]/);
  }
});

test("pagehide delegates bfcache-aware sensor cleanup without a once-only listener", () => {
  assert.match(main, /window\.addEventListener\("pagehide", \(event\) =>/);
  assert.match(main, /shouldDestroySensorsOnPageHide\(event\)/);
  assert.doesNotMatch(main, /pagehide[\s\S]*?\{ once: true \}/);
});
