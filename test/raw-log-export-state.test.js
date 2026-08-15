import test from "node:test";
import assert from "node:assert/strict";

import {
  createRawLogExportState,
  RAW_LOG_EXPORT_STATUS,
} from "../js/core/raw-log-export-state.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("a cancelled raw export retains its exact stopped log and retry success clears it", async () => {
  const log = { samples: [{ timestamp: 1 }] };
  const calls = [];
  let first = true;
  const state = createRawLogExportState({
    async exportLog(candidate) {
      calls.push(candidate);
      if (first) {
        first = false;
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      }
    },
  });

  assert.equal((await state.begin(log)).status, RAW_LOG_EXPORT_STATUS.CANCELLED);
  assert.equal(state.hasPending(), true);
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.CANCELLED);
  assert.equal((await state.retry()).status, RAW_LOG_EXPORT_STATUS.EXPORTED);
  assert.equal(calls[0], log, "the first export receives the exact stopped log object");
  assert.equal(calls[1], log, "retry receives the same retained log object");
  assert.equal(state.hasPending(), false);
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.EXPORTED);
});

test("a failed raw export remains retryable without affecting a separate processed-run export", async () => {
  const log = { samples: [{ timestamp: 2 }] };
  let processedRunSaved = false;
  const state = createRawLogExportState({
    async exportLog() { throw new Error("share unavailable"); },
  });

  processedRunSaved = true;
  const result = await state.begin(log);
  assert.equal(processedRunSaved, true);
  assert.equal(result.status, RAW_LOG_EXPORT_STATUS.FAILED);
  assert.match(result.error.message, /share unavailable/);
  assert.equal(state.hasPending(), true);
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.FAILED);
});

test("an old attempt cannot clear a replacement begun with the same log object", async () => {
  const log = { samples: [{ timestamp: 3 }] };
  const firstExport = deferred();
  const replacementExport = deferred();
  let attempts = 0;
  const state = createRawLogExportState({
    exportLog() {
      attempts += 1;
      return attempts === 1 ? firstExport.promise : replacementExport.promise;
    },
  });

  const oldAttempt = state.begin(log);
  assert.equal(state.discard(), true);
  const replacementAttempt = state.begin(log);
  firstExport.resolve();
  await oldAttempt;

  assert.equal(state.hasPending(), true, "old completion must not clear the replacement export");
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.EXPORTING);
  replacementExport.resolve();
  await replacementAttempt;
  assert.equal(state.hasPending(), false);
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.EXPORTED);
});

test("a pending raw log blocks replacement recording until explicitly discarded", async () => {
  const firstLog = { samples: [{ timestamp: 3 }] };
  const replacementLog = { samples: [{ timestamp: 4 }] };
  const firstExport = deferred();
  const exported = [];
  const state = createRawLogExportState({
    exportLog(log) {
      exported.push(log);
      return log === firstLog ? firstExport.promise : Promise.resolve();
    },
  });

  const firstAttempt = state.begin(firstLog);
  assert.throws(() => state.begin(replacementLog), /exported or discarded/);
  assert.equal(state.discard(), true);
  const replacementAttempt = state.begin(replacementLog);
  firstExport.resolve();
  await firstAttempt;
  await replacementAttempt;

  assert.deepEqual(exported, [firstLog, replacementLog]);
  assert.equal(state.hasPending(), false);
  assert.equal(state.getStatus(), RAW_LOG_EXPORT_STATUS.EXPORTED);
});
