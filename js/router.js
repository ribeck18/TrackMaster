export const STATES = Object.freeze([
  "enable",
  "cal",
  "ready",
  "race",
  "report",
  "permission-denied",
]);

const TRANSITIONS = Object.freeze({
  enable: Object.freeze({
    ENABLE: "cal",
    PERMISSION_DENIED: "permission-denied",
  }),
  cal: Object.freeze({ ZERO: "ready" }),
  ready: Object.freeze({ START_RACE: "race" }),
  race: Object.freeze({ NEXT_LAP: "race", END_RACE: "report" }),
  report: Object.freeze({ NEW_RUN: "ready" }),
  "permission-denied": Object.freeze({ CONTINUE_LIMITED: "cal" }),
});

export function isState(value) {
  return STATES.includes(value);
}

export function transition(currentState, event) {
  if (!isState(currentState)) {
    throw new TypeError(`Unknown app state: ${currentState}`);
  }

  return TRANSITIONS[currentState][event] ?? currentState;
}
