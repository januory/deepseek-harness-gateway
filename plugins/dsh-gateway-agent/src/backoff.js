// Exponential backoff helpers for outbound reconnect (ADR-0010 §功能清单 2).
// Pure functions so the timing policy is unit-testable without real timers.

/** The backoff to use AFTER a failed attempt (double, capped). */
export function nextBackoff(ms, maxMs) {
  return Math.min(ms * 2, maxMs)
}

/** This attempt's delay: current backoff (capped) plus up to `jitterMs` jitter. */
export function backoffDelay(ms, maxMs, rand = Math.random, jitterMs = 500) {
  return Math.min(ms, maxMs) + Math.floor(rand() * (jitterMs + 1))
}
