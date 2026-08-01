import test from "node:test";
import assert from "node:assert/strict";

import { shouldDestroySensorsOnPageHide } from "../js/page-lifecycle.js";

test("persisted pagehide keeps sensors alive for back-forward cache restoration", () => {
  assert.equal(shouldDestroySensorsOnPageHide({ persisted: true }), false);
});

test("final pagehide releases sensors", () => {
  assert.equal(shouldDestroySensorsOnPageHide({ persisted: false }), true);
  assert.equal(shouldDestroySensorsOnPageHide(), true);
});
