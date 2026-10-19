/** Finite logical admission and transport budgets, not OS CPU/RSS or thread-exit guarantees. */
export default {
  globalReservations: 1,
  accountReservations: 1,
  incidentReservations: 1,
  subscribers: 1,
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
  recordingBytes: 16 * 1024 * 1024,
} as const
