/** Owns the screen wake lock only while a race is active. */
export function createRaceWakeLock({
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
} = {}) {
  let active = false;
  let sentinel = null;
  let pendingRequest = null;

  function pageIsVisible() {
    return documentRef?.visibilityState !== "hidden";
  }

  function detach(current) {
    current?.removeEventListener?.("release", handleRelease);
  }

  function handleRelease(event) {
    const released = event?.currentTarget ?? sentinel;
    detach(released);
    if (sentinel === released) sentinel = null;
    if (active && pageIsVisible()) void acquire();
  }

  async function acquire() {
    if (!active || !pageIsVisible() || sentinel) return sentinel;
    // Adopt the in-flight request rather than returning the currently-null
    // sentinel. Restart logic must observe its eventual success or rejection.
    if (pendingRequest) return pendingRequest;
    if (typeof navigatorRef?.wakeLock?.request !== "function") return null;

    pendingRequest = Promise.resolve()
      .then(() => navigatorRef.wakeLock.request("screen"))
      .then(async (nextSentinel) => {
        if (!active || !pageIsVisible()) {
          await nextSentinel?.release?.();
          return null;
        }
        sentinel = nextSentinel;
        sentinel?.addEventListener?.("release", handleRelease);
        return sentinel;
      })
      .catch(() => null)
      .finally(() => {
        pendingRequest = null;
      });
    return pendingRequest;
  }

  function handleVisibilityChange() {
    if (active && pageIsVisible()) void acquire();
  }

  documentRef?.addEventListener?.("visibilitychange", handleVisibilityChange);

  async function start() {
    active = true;
    const inheritedRequest = pendingRequest;
    await acquire();
    // If this race started while the prior race's request was being discarded,
    // acquire once that cleanup finishes. Do not leave the restarted race active
    // without a lock merely because it briefly inherited an unusable promise.
    if (inheritedRequest && active && pageIsVisible() && !sentinel) {
      return acquire();
    }
    return sentinel;
  }

  async function stop() {
    active = false;
    // Capture ownership before yielding. A subsequent race may start while an
    // old request/release is pending, and this stop must never release the new
    // race's sentinel when its awaits resume.
    const current = sentinel;
    sentinel = null;
    detach(current);
    const pending = pendingRequest;
    try {
      await current?.release?.();
    } catch {
      // The platform may already have released it while the page was hidden.
    }
    if (pending) await pending;
  }

  async function destroy() {
    documentRef?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    await stop();
  }

  return Object.freeze({ start, stop, destroy, isActive: () => active });
}
