function requireTimestamp(timestamp, label) {
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a finite timestamp.`);
  return timestamp;
}

function requireRunningSession(session) {
  if (!session || !Number.isFinite(session.sessionStartTime) || !Number.isFinite(session.currentLapStartTime)) {
    throw new TypeError("A running lap session is required.");
  }
  if (session.endedAt !== null) throw new Error("The lap session has already ended.");
}

function elapsedBetween(start, end) {
  if (end < start) throw new RangeError("Lap timestamps must be monotonic.");
  return end - start;
}

/** Formats a duration without using wall-clock dates. */
export function formatLapTime(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Lap duration must be a non-negative finite number.");
  }
  const elapsedTenths = Math.floor(elapsedMs / 100);
  const minutes = Math.floor(elapsedTenths / 600);
  const seconds = Math.floor((elapsedTenths % 600) / 10);
  const tenths = elapsedTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function startLapTiming(timestamp) {
  const start = requireTimestamp(timestamp, "Session start");
  return Object.freeze({
    sessionStartTime: start,
    currentLapStartTime: start,
    lapNumber: 1,
    laps: Object.freeze([]),
    endedAt: null,
  });
}

export function currentLapElapsed(session, timestamp) {
  requireRunningSession(session);
  return elapsedBetween(session.currentLapStartTime, requireTimestamp(timestamp, "Current time"));
}

export function completeLap(session, timestamp) {
  requireRunningSession(session);
  const endTime = requireTimestamp(timestamp, "Lap end");
  if (endTime <= session.currentLapStartTime) {
    throw new RangeError("Lap end must be strictly after its start timestamp.");
  }
  const duration = endTime - session.currentLapStartTime;
  const completed = Object.freeze({
    index: session.lapNumber,
    startTime: session.currentLapStartTime,
    endTime,
    duration,
  });
  return Object.freeze({
    ...session,
    currentLapStartTime: endTime,
    lapNumber: session.lapNumber + 1,
    laps: Object.freeze([...session.laps, completed]),
  });
}

/** Ends the session without turning the partial current lap into a completed lap. */
export function endLapTiming(session, timestamp) {
  requireRunningSession(session);
  const endedAt = requireTimestamp(timestamp, "Session end");
  elapsedBetween(session.currentLapStartTime, endedAt);
  return Object.freeze({ ...session, endedAt });
}

export function sessionElapsed(session, timestamp = session?.endedAt) {
  if (!session || !Number.isFinite(session.sessionStartTime)) {
    throw new TypeError("A lap session is required.");
  }
  return elapsedBetween(
    session.sessionStartTime,
    requireTimestamp(timestamp, "Session time"),
  );
}
