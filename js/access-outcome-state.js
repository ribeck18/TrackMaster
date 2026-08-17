/**
 * Buffers sensor access upgrades that can arrive while the initial combined
 * permission request is still waiting for its other sensor.
 */
export function createAccessOutcomeState() {
  const pending = new Map();
  let current = null;

  function record(sensor, outcome) {
    if (current === null) {
      pending.set(sensor, outcome);
      return null;
    }

    current = Object.freeze({ ...current, [sensor]: outcome });
    return current;
  }

  function initialize(initialOutcomes) {
    current = Object.freeze({
      ...initialOutcomes,
      ...Object.fromEntries(pending),
    });
    pending.clear();
    return current;
  }

  function getCurrent() {
    return current;
  }

  function getPending() {
    return Object.freeze(Object.fromEntries(pending));
  }

  return Object.freeze({ record, initialize, getCurrent, getPending });
}
