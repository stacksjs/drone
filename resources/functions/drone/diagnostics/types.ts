export const diagnosticLimits = Object.freeze({ fileBytes: 4194304, lineBytes: 4096, events: 4096, queue: 32, footerReserveBytes: 2048, durationMs: 86400000 })
export const diagnosticHealthCodes = ['transport-loss', 'host-error', 'clock-discontinuity', 'watchdog-reset', 'deadline-miss', 'protocol-rejected'] as const
export interface DiagnosticProvenance { firmwareSha256: string, configurationSha256: string, modelSha256: string, calibrationSha256: string, runtimeProtocol: 1 }
export interface DiagnosticHeader {
  kind: 'header'
  format: 'drone-diagnostics'
  version: 1
  runId: string
  evidence: 'host-harness' | 'fixture' | 'board-capture'
  provenance: DiagnosticProvenance
  maxBytes: number
  maxEvents: number
  privacy: 'runtime-only'
  physicalFlightEnabled: false
}
export interface RecordedRuntimeFrame {
  kind: 'hello' | 'lease' | 'stop' | 'status'
  sequence: number
  bootId: string
  sessionId: string
  sampleTimeUs: string
  leaseUs: number
  sample: number
  ticks: number
  deadlineMisses: number
  flags: number
  maxExecutionUs: number
  stateBytes: number
}
export type DiagnosticEvent = { kind: 'runtime', direction: 'rx' | 'tx', frame: RecordedRuntimeFrame } | { kind: 'tick', boardUs: string } | { kind: 'health', code: typeof diagnosticHealthCodes[number] }
export interface DiagnosticEntry { kind: 'event', sequence: number, atMs: number, event: DiagnosticEvent, previousHash: string, hash: string }
export interface DiagnosticFooter { kind: 'end', atMs: number, attempted: number, written: number, droppedQueue: number, droppedCapacity: number, droppedStorage: number, reason: 'completed' | 'interrupted' | 'host-error', previousHash: string, hash: string }
export interface DiagnosticJournal {
  header: DiagnosticHeader
  events: DiagnosticEntry[]
  footer: DiagnosticFooter | null
  completion: 'completed' | 'interrupted' | 'host-error' | 'unfinalized'
  loss: { knownDropped: number, tailUnknown: boolean }
  verifiedHash: string
  discardedTailBytes: number
}
