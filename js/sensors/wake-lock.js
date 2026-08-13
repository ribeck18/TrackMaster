/** States exposed while a race owns (or tries to own) the screen wake lock. */
export const WAKE_LOCK_STATE = Object.freeze({
  HELD: "held",
  UNSUPPORTED: "unsupported",
  REJECTED: "rejected",
  RELEASED: "released",
});

/** Owns the screen wake lock only while a race is active. */
export function createRaceWakeLock({
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
} = {}) {
  let active = false;
  let sentinel = null;
  let pendingRequest = null;
  let state = WAKE_LOCK_STATE.RELEASED;
  const listeners = new Set();

  function setState(nextState) {
    if (state === nextState) return;
    state = nextState;
    for (const listener of listeners) listener(state);
  }

  function pageIsVisible() {
    return documentRef?.visibilityState !== "hidden";
  }

  function detach(current) {
    current?.removeEventListener?.("release", handleRelease);
  }

  function handleRelease(event) {
    const released = event?.currentTarget ?? sentinel;
    if (sentinel !== released) return;
    detach(released);
    sentinel = null;
    setState(WAKE_LOCK_STATE.RELEASED);
    if (active && pageIsVisible()) void acquire();
  }

  async function acquire() {
    if (!active || !pageIsVisible() || sentinel) return state;
    // Adopt the in-flight request rather than starting a duplicate request.
    if (pendingRequest) return pendingRequest;
    if (typeof navigatorRef?.wakeLock?.request !== "function") {
      setState(WAKE_LOCK_STATE.UNSUPPORTED);
      return state;
    }

    pendingRequest = Promise.resolve()
      .then(() => navigatorRef.wakeLock.request("screen"))
      .then(async (nextSentinel) => {
        if (!nextSentinel) throw new TypeError("Screen Wake Lock returned no sentinel.");
        if (!active || !pageIsVisible()) {
          try {
            await nextSentinel.release?.();
          } catch {
            // A lock discarded during a race transition may already be released.
          }
          if (!active || !sentinel) setState(WAKE_LOCK_STATE.RELEASED);
          return state;
        }
        sentinel = nextSentinel;
        sentinel.addEventListener?.("release", handleRelease);
        setState(WAKE_LOCK_STATE.HELD);
        return state;
      })
      .catch(() => {
        // A rejection is meaningful only while this race remains eligible to hold a lock.
        if (active && pageIsVisible() && !sentinel) setState(WAKE_LOCK_STATE.REJECTED);
        else if (!sentinel) setState(WAKE_LOCK_STATE.RELEASED);
        return state;
      })
      .finally(() => {
        pendingRequest = null;
      });
    return pendingRequest;
  }

  function handleVisibilityChange() {
    if (!pageIsVisible()) {
      // A screen lock cannot be relied on in a hidden document. Relinquish our
      // reference immediately so a visible restore always obtains a fresh lock.
      const current = sentinel;
      if (!current) return;
      sentinel = null;
      detach(current);
      setState(WAKE_LOCK_STATE.RELEASED);
      void Promise.resolve().then(() => current.release?.()).catch(() => {
        // The browser may have already released this sentinel on hide.
      });
      return;
    }
    if (active) void acquire();
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
    return state;
  }

  async function stop() {
    active = false;
    // Capture ownership before yielding. A subsequent race may start while an
    // old request/release is pending, and this stop must never release the new
    // race's sentinel when its awaits resume.
    const current = sentinel;
    sentinel = null;
    detach(current);
    setState(WAKE_LOCK_STATE.RELEASED);
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

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Wake-lock listener must be a function.");
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    start,
    stop,
    destroy,
    subscribe,
    getState: () => state,
    isActive: () => active,
  });
}
