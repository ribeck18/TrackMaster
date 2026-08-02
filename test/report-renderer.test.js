import test from "node:test";
import assert from "node:assert/strict";

import { aggregateRunReport } from "../js/core/report.js";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.queries = new Map();
  }

  querySelector(selector) {
    return this.queries.get(selector) ?? null;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

globalThis.Element = FakeElement;
globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
const { renderRunReport } = await import("../js/ui/run-report.js");

function reportRoot() {
  const root = new FakeElement("section");
  for (const selector of [
    "[data-report-meta]",
    "[data-report-best]",
    "[data-report-laps]",
    "[data-report-max-speed]",
    "[data-report-avg-speed]",
    "[data-report-left-lean]",
    "[data-report-right-lean]",
    "[data-top-speed]",
    "[data-top-speed-context]",
    "[data-top-speed-marker]",
    "[data-save-status]",
  ]) {
    root.queries.set(selector, new FakeElement());
  }
  const map = new FakeElement();
  map.queries.set("[data-map-state]", new FakeElement());
  root.queries.set("[data-report-map]", map);
  return root;
}

function timing({ laps = [], endedAt = 3_000 } = {}) {
  return {
    sessionStartTime: 0,
    currentLapStartTime: laps.at(-1)?.endTime ?? 0,
    lapNumber: laps.length + 1,
    laps,
    endedAt,
  };
}

test("renderer writes populated values, best classes, location state, and then empty states", () => {
  const root = reportRoot();
  const populated = aggregateRunReport(
    {
      timing: timing({
        laps: [
          { index: 1, startTime: 0, endTime: 1_000, duration: 1_000 },
          { index: 2, startTime: 1_000, endTime: 2_000, duration: 1_000 },
        ],
      }),
      samples: [
        { timestamp: 0, speedMph: 20, speedValid: true, leanDegrees: -30, latitude: 1, longitude: 2 },
        { timestamp: 1_000, speedMph: 40, speedValid: true, leanDegrees: 25, latitude: 1, longitude: 2 },
      ],
    },
    { runNumber: 2 },
  );

  renderRunReport(root, populated);
  assert.equal(root.querySelector("[data-report-meta]").textContent, "RUN 2 · 2 LAPS · 00:03.0 TOTAL");
  assert.equal(root.querySelector("[data-report-best]").textContent, "BEST 00:01.0");
  assert.equal(root.querySelector("[data-report-laps]").children.length, 2);
  assert.match(root.querySelector("[data-report-laps]").children[0].className, /report-lap--best/);
  assert.equal(root.querySelector("[data-report-max-speed]").textContent, "40");
  assert.equal(root.querySelector("[data-report-avg-speed]").textContent, "30");
  assert.equal(root.querySelector("[data-report-left-lean]").textContent, "30°");
  assert.equal(root.querySelector("[data-report-right-lean]").textContent, "25°");
  assert.equal(root.querySelector("[data-report-map]").dataset.location, "available");
  assert.equal(root.querySelector("[data-top-speed]").textContent, "40 MPH");

  const empty = aggregateRunReport({ timing: timing({ endedAt: 500 }), samples: [] });
  renderRunReport(root, empty);
  assert.equal(root.querySelector("[data-report-laps]").children.length, 1);
  assert.equal(root.querySelector("[data-report-laps]").children[0].textContent, "NO COMPLETED LAPS");
  assert.equal(root.querySelector("[data-report-max-speed]").textContent, "--");
  assert.equal(root.querySelector("[data-report-map]").dataset.location, "unavailable");
  assert.equal(root.querySelector("[data-top-speed-context]").textContent, "NO SPEED DATA");
});
