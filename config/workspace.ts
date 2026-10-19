/** Single-process native HTTP stream budgets. No durable replay or extra listener. */
export interface WorkspaceHttpLimits {
  globalConnections: number
  accountConnections: number
  incidentConnections: number
  pendingChecks: number
  nativePending: number
  frameBytes: number
  heartbeatMs: number
  lifetimeMs: number
  checkTimeoutMs: number
}

export default {
  globalConnections: 32,
  accountConnections: 2,
  incidentConnections: 8,
  pendingChecks: 64,
  nativePending: 8,
  frameBytes: 1024,
  heartbeatMs: 2000,
  lifetimeMs: 30000,
  checkTimeoutMs: 2000,
} satisfies WorkspaceHttpLimits
