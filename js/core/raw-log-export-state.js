export const RAW_LOG_EXPORT_STATUS = Object.freeze({
  EXPORTING: "exporting",
  CANCELLED: "cancelled",
  FAILED: "failed",
  EXPORTED: "exported",
});

function isCancellation(error) {
  return error?.name === "AbortError" || error?.code === 20;
}

/**
 * Keeps one stopped raw log alive across export attempts. The log is only
 * released after a successful export or an explicit discard.
 */
export function createRawLogExportState({ exportLog } = {}) {
  if (typeof exportLog !== "function") {
    throw new TypeError("Raw log export state requires an export function.");
  }

  const subscribers = new Set();
  let pending = null;
  let status = null;
  let nextGeneration = 0;

  function snapshot() {
    return Object.freeze({ status, pending: pending !== null });
  }

  function notify() {
    const next = snapshot();
    for (const subscriber of subscribers) subscriber(next);
  }

  async function attempt({ log, generation }) {
    status = RAW_LOG_EXPORT_STATUS.EXPORTING;
    notify();
    try {
      await exportLog(log);
      if (pending?.generation === generation) {
        pending = null;
        status = RAW_LOG_EXPORT_STATUS.EXPORTED;
        notify();
      }
      return Object.freeze({ status: RAW_LOG_EXPORT_STATUS.EXPORTED, error: null });
    } catch (error) {
      const outcome = isCancellation(error)
        ? RAW_LOG_EXPORT_STATUS.CANCELLED
        : RAW_LOG_EXPORT_STATUS.FAILED;
      if (pending?.generation === generation) {
        status = outcome;
        notify();
      }
      return Object.freeze({ status: outcome, error });
    }
  }

  function begin(log) {
    if (pending) throw new Error("A raw log must be exported or discarded before recording again.");
    if (!log || typeof log !== "object") throw new TypeError("Raw log export requires a stopped log.");
    pending = { log, generation: ++nextGeneration };
    return attempt(pending);
  }

  function retry() {
    if (!pending || ![RAW_LOG_EXPORT_STATUS.CANCELLED, RAW_LOG_EXPORT_STATUS.FAILED].includes(status)) {
      return null;
    }
    return attempt(pending);
  }

  function discard() {
    if (!pending) return false;
    pending = null;
    status = null;
    notify();
    return true;
  }

  return Object.freeze({
    begin,
    retry,
    discard,
    hasPending: () => pending !== null,
    getStatus: () => status,
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("Raw log export subscriber must be a function.");
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  });
}
