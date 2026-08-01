import test from "node:test";
import assert from "node:assert/strict";

import { STATES, isState, transition } from "../js/router.js";

test("the shell exposes exactly the six approved states", () => {
  assert.deepEqual(STATES, [
    "enable",
    "cal",
    "ready",
    "race",
    "report",
    "permission-denied",
  ]);
});

test("the normal rider flow reaches every primary screen", () => {
  let state = "enable";
  state = transition(state, "ENABLE");
  assert.equal(state, "cal");
  state = transition(state, "ZERO");
  assert.equal(state, "ready");
  state = transition(state, "START_RACE");
  assert.equal(state, "race");
  state = transition(state, "NEXT_LAP");
  assert.equal(state, "race");
  state = transition(state, "END_RACE");
  assert.equal(state, "report");
  state = transition(state, "NEW_RUN");
  assert.equal(state, "ready");
});

test("permission denial has a non-blocking recovery route", () => {
  assert.equal(transition("enable", "PERMISSION_DENIED"), "permission-denied");
  assert.equal(transition("permission-denied", "CONTINUE_LIMITED"), "cal");
});

test("unknown events are ignored and unknown states are rejected", () => {
  assert.equal(transition("ready", "NOT_AN_EVENT"), "ready");
  assert.equal(isState("other"), false);
  assert.throws(() => transition("other", "ENABLE"), /Unknown app state/);
});
