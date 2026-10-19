/** Finite logical budgets, not OS CPU/RSS or thread-exit guarantees.
 * One global/account/incident reservation, one subscriber, and the canonical 16 MiB
 * recording ceiling are fixed protocol invariants rather than editable limits.
 */
export default {
  pendingChecks: 8,
  nativePending: 2,
  frameBytes: 4096,
  heartbeatMs: 2000,
  checkTimeoutMs: 2000,
  streamLifetimeMs: 30000,
  consumerGraceMs: 10000,
  creditWaitMs: 20000,
  runWallMs: 60000,
  stopGraceMs: 2000,
  retainedMs: 60000,
} as const
