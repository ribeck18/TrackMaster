import test from "node:test";
import assert from "node:assert/strict";

import { adjustLapBoundary, aggregateRunReport } from "../js/core/report.js";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.listeners = new Map();
    this.queries = new Map();
  }

  querySelector(selector) {
    const mapped = this.queries.get(selector);
    if (mapped) return mapped;
    const attributes = [...selector.matchAll(/\[data-([a-z-]+)="([^"]+)"\]/g)];
    if (attributes.length > 0 && attributes.every(([, name, value]) => {
      const key = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.dataset[key] === value;
    })) {
      return this;
    }
    for (const child of this.children) {
      const match = child.querySelector?.(selector);
      if (match) return match;
    }
    for (const queried of this.queries.values()) {
      const match = queried.querySelector?.(selector);
      if (match) return match;
    }
    return null;
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

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  click() {
    if (!this.disabled) this.listeners.get("click")?.();
  }

  focus() {
    this.focused = true;
    globalThis.document.activeElement = this;
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

test("lap rows reveal accessible trim controls and send exact 0.1 second steps", () => {
  const root = reportRoot();
  const populated = aggregateRunReport({
    timing: timing({
      laps: [
        { index: 1, startTime: 0, endTime: 1_000, duration: 1_000 },
        { index: 2, startTime: 1_000, endTime: 2_000, duration: 1_000 },
      ],
      endedAt: 2_500,
    }),
    samples: [],
  });
  const activations = [];

  renderRunReport(root, populated, { onTrim: (...args) => activations.push(args) });
  const row = root.querySelector("[data-report-laps]").children[0];
  const summary = row.children[0];
  const controls = row.children[1];
  assert.equal(summary.attributes.get("aria-expanded"), "false");
  assert.equal(controls.hidden, true);

  summary.click();
  assert.equal(summary.attributes.get("aria-expanded"), "true");
  assert.equal(controls.hidden, false);
  assert.match(controls.children[0].attributes.get("aria-label"), /earlier by 0\.1 seconds/);
  assert.match(controls.children[2].attributes.get("aria-label"), /later by 0\.1 seconds/);
  controls.children[0].click();
  controls.children[2].click();
  assert.deepEqual(activations, [[1, -100], [1, 100]]);
});

test("multiple lap rows behave as one accordion and preserve expansion and trim focus across rerender", () => {
  const root = reportRoot();
  const original = aggregateRunReport({
    timing: timing({
      laps: [
        { index: 1, startTime: 0, endTime: 1_000, duration: 1_000 },
        { index: 2, startTime: 1_000, endTime: 2_000, duration: 1_000 },
        { index: 3, startTime: 2_000, endTime: 3_000, duration: 1_000 },
      ],
      endedAt: 3_500,
    }),
    samples: [],
  });

  renderRunReport(root, original);
  const [first] = root.querySelector("[data-report-laps]").children;
  first.children[0].click();
  assert.equal(first.children[0].getAttribute("aria-expanded"), "true");

  const staleExpandedSummary = first.children[0];
  renderRunReport(root, original);
  const rowsAfterRerender = root.querySelector("[data-report-laps]").children;
  rowsAfterRerender[1].children[0].click();
  assert.equal(rowsAfterRerender[0].children[0].getAttribute("aria-expanded"), "false");
  assert.equal(rowsAfterRerender[0].children[1].hidden, true);
  assert.equal(rowsAfterRerender[1].children[0].getAttribute("aria-expanded"), "true");
  assert.equal(root.dataset.expandedLap, "2");

  staleExpandedSummary.click();
  assert.equal(root.dataset.expandedLap, "2", "a stale close only clears its matching row state");
  assert.equal(rowsAfterRerender[1].children[0].getAttribute("aria-expanded"), "true");

  const adjusted = adjustLapBoundary(original, 2, 100);
  renderRunReport(root, adjusted, { focusTrim: { lapIndex: 2, adjustmentMs: 100 } });
  const rerenderedRows = root.querySelector("[data-report-laps]").children;
  assert.equal(rerenderedRows[0].children[0].getAttribute("aria-expanded"), "false");
  assert.equal(rerenderedRows[1].children[0].getAttribute("aria-expanded"), "true");
  assert.equal(rerenderedRows[1].children[1].hidden, false);
  assert.equal(globalThis.document.activeElement.dataset.trimLap, "2");
  assert.equal(globalThis.document.activeElement.dataset.trimAdjustment, "100");

  rerenderedRows[1].children[0].click();
  assert.equal(root.dataset.expandedLap, undefined);
  assert.equal(rerenderedRows[1].children[0].getAttribute("aria-expanded"), "false");
});

test("a stale collapsed summary cannot open or desynchronize the current accordion render", () => {
  const root = reportRoot();
  const populated = aggregateRunReport({
    timing: timing({
      laps: [
        { index: 1, startTime: 0, endTime: 1_000, duration: 1_000 },
        { index: 2, startTime: 1_000, endTime: 2_000, duration: 1_000 },
        { index: 3, startTime: 2_000, endTime: 3_000, duration: 1_000 },
      ],
      endedAt: 3_500,
    }),
    samples: [],
  });

  renderRunReport(root, populated);
  const staleCollapsedSummary = root.querySelector("[data-report-laps]").children[2].children[0];
  renderRunReport(root, populated);
  const currentRows = root.querySelector("[data-report-laps]").children;
  currentRows[1].children[0].click();
  assert.equal(root.dataset.expandedLap, "2");

  staleCollapsedSummary.click();
  assert.equal(root.dataset.expandedLap, "2");
  assert.equal(currentRows[1].children[0].getAttribute("aria-expanded"), "true");
  assert.equal(currentRows[1].children[1].hidden, false);
  assert.equal(currentRows[2].children[0].getAttribute("aria-expanded"), "false");
  assert.equal(currentRows[2].children[1].hidden, true);
});

test("cap controls render disabled and cannot emit stale activations", () => {
  const root = reportRoot();
  let capped = aggregateRunReport({
    timing: timing({
      laps: [{ index: 1, startTime: 0, endTime: 1_000, duration: 1_000 }],
      endedAt: 2_000,
    }),
    samples: [],
  });
  for (let step = 0; step < 5; step += 1) capped = adjustLapBoundary(capped, 1, 100);
  const activations = [];

  root.dataset.expandedLap = "1";
  renderRunReport(root, capped, {
    onTrim: (...args) => activations.push(args),
    focusTrim: { lapIndex: 1, adjustmentMs: 100 },
  });
  const controls = root.querySelector("[data-report-laps]").children[0].children[1];
  assert.equal(controls.children[2].disabled, true);
  assert.equal(controls.children[0].disabled, false);
  assert.equal(globalThis.document.activeElement.dataset.lapSummary, "1");
  controls.children[2].click();
  assert.deepEqual(activations, []);
});

test("rendering a new report after clearing accordion state starts with every row collapsed", () => {
  const root = reportRoot();
  const populated = aggregateRunReport({
    timing: timing({
      laps: [{ index: 1, startTime: 0, endTime: 1_000, duration: 1_000 }],
      endedAt: 1_500,
    }),
    samples: [],
  });
  renderRunReport(root, populated);
  root.querySelector("[data-report-laps]").children[0].children[0].click();
  assert.equal(root.dataset.expandedLap, "1");

  delete root.dataset.expandedLap;
  renderRunReport(root, populated);
  assert.equal(
    root.querySelector("[data-report-laps]").children[0].children[0].getAttribute("aria-expanded"),
    "false",
  );
});
