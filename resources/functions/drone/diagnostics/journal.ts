import type { DiagnosticEntry, DiagnosticEvent, DiagnosticFooter, DiagnosticHeader, DiagnosticJournal, DiagnosticProvenance, RecordedRuntimeFrame } from './types'
import type { RuntimeFrame } from '../runtime/protocol'
import { encodeRuntimeFrame } from '../runtime/protocol'
import { diagnosticHealthCodes, diagnosticLimits } from './types'

export function diagnosticObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid diagnostic object')
  return value as Record<string, unknown>
}
export function diagnosticKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new TypeError('Unsupported diagnostic fields; private context is never accepted')
}
export function diagnosticInteger(value: unknown, min = 0, max = 0xFFFFFFFF): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid diagnostic integer')
  return value
}
export function diagnosticTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > diagnosticLimits.durationMs) throw new TypeError('Invalid diagnostic time')
  return value
}
const hashPattern = /^[a-f\d]{64}$/
export function diagnosticHash(value: unknown): string { if (typeof value !== 'string' || !hashPattern.test(value)) throw new TypeError('Invalid diagnostic digest'); return value }
export async function hashDiagnostic(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
}
export function validateDiagnosticProvenance(input: unknown): DiagnosticProvenance {
  const p = diagnosticObject(input)
  diagnosticKeys(p, ['firmwareSha256', 'configurationSha256', 'modelSha256', 'calibrationSha256', 'runtimeProtocol'])
  if (p.runtimeProtocol !== 1) throw new TypeError('Unsupported runtime provenance version')
  return { firmwareSha256: diagnosticHash(p.firmwareSha256), configurationSha256: diagnosticHash(p.configurationSha256), modelSha256: diagnosticHash(p.modelSha256), calibrationSha256: diagnosticHash(p.calibrationSha256), runtimeProtocol: 1 }
}
export function validateDiagnosticHeader(input: unknown): DiagnosticHeader {
  const h = diagnosticObject(input)
  diagnosticKeys(h, ['kind', 'format', 'version', 'runId', 'evidence', 'provenance', 'maxBytes', 'maxEvents', 'privacy', 'physicalFlightEnabled'])
  if (h.kind !== 'header' || h.format !== 'drone-diagnostics' || h.version !== 1 || typeof h.runId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(h.runId) || (typeof h.evidence !== 'string' || !['host-harness', 'fixture', 'board-capture'].includes(h.evidence)) || h.privacy !== 'runtime-only' || h.physicalFlightEnabled !== false) throw new TypeError('Invalid diagnostic header')
  return { kind: 'header', format: 'drone-diagnostics', version: 1, runId: h.runId, evidence: h.evidence as DiagnosticHeader['evidence'], provenance: validateDiagnosticProvenance(h.provenance), maxBytes: diagnosticInteger(h.maxBytes, 8192, diagnosticLimits.fileBytes), maxEvents: diagnosticInteger(h.maxEvents, 1, diagnosticLimits.events), privacy: 'runtime-only', physicalFlightEnabled: false }
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 0xFFFFFFFFFFFFFFFFn) throw new TypeError('Invalid diagnostic uint64')
  return value
}
export function recordRuntimeFrame(frame: RuntimeFrame): RecordedRuntimeFrame {
  return { kind: frame.kind, sequence: frame.sequence, bootId: String(frame.bootId), sessionId: String(frame.sessionId), sampleTimeUs: String(frame.sampleTimeUs), leaseUs: frame.leaseUs, sample: frame.sample, ticks: frame.ticks, deadlineMisses: frame.deadlineMisses, flags: frame.flags, maxExecutionUs: frame.maxExecutionUs, stateBytes: frame.stateBytes }
}
export function restoreRecordedRuntimeFrame(input: unknown): RuntimeFrame {
  const f = diagnosticObject(input)
  diagnosticKeys(f, ['kind', 'sequence', 'bootId', 'sessionId', 'sampleTimeUs', 'leaseUs', 'sample', 'ticks', 'deadlineMisses', 'flags', 'maxExecutionUs', 'stateBytes'])
  if (typeof f.kind !== 'string' || !['hello', 'lease', 'stop', 'status'].includes(f.kind)) throw new TypeError('Invalid diagnostic frame kind')
  const frame: RuntimeFrame = { kind: f.kind as RuntimeFrame['kind'], sequence: diagnosticInteger(f.sequence), bootId: BigInt(decimal(f.bootId)), sessionId: BigInt(decimal(f.sessionId)), sampleTimeUs: BigInt(decimal(f.sampleTimeUs)), leaseUs: diagnosticInteger(f.leaseUs), sample: diagnosticInteger(f.sample, -0x80000000, 0x7FFFFFFF), ticks: diagnosticInteger(f.ticks), deadlineMisses: diagnosticInteger(f.deadlineMisses), flags: diagnosticInteger(f.flags), maxExecutionUs: diagnosticInteger(f.maxExecutionUs), stateBytes: diagnosticInteger(f.stateBytes) }
  encodeRuntimeFrame(frame)
  return frame
}
export function validateDiagnosticEvent(input: unknown): DiagnosticEvent {
  const e = diagnosticObject(input)
  if (e.kind === 'tick') { diagnosticKeys(e, ['kind', 'boardUs']); return { kind: 'tick', boardUs: decimal(e.boardUs) } }
  if (e.kind === 'health') {
    diagnosticKeys(e, ['kind', 'code'])
    if (!diagnosticHealthCodes.includes(e.code as never)) throw new TypeError('Invalid diagnostic health code')
    return { kind: 'health', code: e.code as typeof diagnosticHealthCodes[number] }
  }
  diagnosticKeys(e, ['kind', 'direction', 'frame'])
  if (e.kind !== 'runtime' || (typeof e.direction !== 'string' || !['rx', 'tx'].includes(e.direction))) throw new TypeError('Invalid diagnostic event')
  const frame = restoreRecordedRuntimeFrame(e.frame)
  if ((e.direction === 'rx') !== (frame.kind === 'status')) throw new TypeError('Diagnostic direction and frame disagree')
  if (e.direction === 'tx' && [frame.sample, frame.ticks, frame.deadlineMisses, frame.flags, frame.maxExecutionUs, frame.stateBytes].some(n => n !== 0)) throw new TypeError('Command logs cannot contain opaque payload fields')
  return { kind: 'runtime', direction: e.direction as 'rx' | 'tx', frame: recordRuntimeFrame(frame) }
}
export async function sealDiagnostic<T extends object>(body: T): Promise<T & { hash: string }> { return { ...body, hash: await hashDiagnostic(JSON.stringify(body)) } }
function parseDiagnosticJson(line: string): unknown {
  try { return JSON.parse(line) }
  catch { throw new TypeError('Malformed diagnostic JSON line') }
}
/** Hash-chain validation is accidental-corruption detection, not sender authentication. Only a partial final line is recoverable. */
export async function parseDiagnosticsJournal(text: string): Promise<DiagnosticJournal> {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > diagnosticLimits.fileBytes) throw new RangeError('Diagnostic journal exceeds 4 MiB')
  const newline = text.lastIndexOf('\n')
  const tail = text.slice(newline + 1)
  const complete = text.slice(0, newline + 1).split('\n')
  complete.pop()
  if (!complete.length || complete.length > diagnosticLimits.events + 2 || complete.some(line => !line || new TextEncoder().encode(line).length > diagnosticLimits.lineBytes)) throw new TypeError('Invalid bounded diagnostic lines')
  const header = validateDiagnosticHeader(parseDiagnosticJson(complete[0]!))
  if (new TextEncoder().encode(text).length > header.maxBytes) throw new RangeError('Journal exceeds its declared byte budget')
  let previousHash = await hashDiagnostic(JSON.stringify(header)), sequence = 0, atMs = 0
  const events: DiagnosticEntry[] = []
  let footer: DiagnosticFooter | null = null
  for (const line of complete.slice(1)) {
    const p = diagnosticObject(parseDiagnosticJson(line))
    if (footer) throw new TypeError('Data after diagnostic completion marker')
    if (p.previousHash !== previousHash) throw new TypeError('Diagnostic hash chain is broken')
    if (p.kind === 'event') {
      diagnosticKeys(p, ['kind', 'sequence', 'atMs', 'event', 'previousHash', 'hash'])
      const body = { kind: 'event' as const, sequence: diagnosticInteger(p.sequence, 1), atMs: diagnosticTime(p.atMs), event: validateDiagnosticEvent(p.event), previousHash }
      if (body.sequence <= sequence || body.atMs < atMs || events.length >= header.maxEvents) throw new TypeError('Diagnostic event order or capacity invalid')
      if (await hashDiagnostic(JSON.stringify(body)) !== diagnosticHash(p.hash)) throw new TypeError('Diagnostic record digest mismatch')
      previousHash = p.hash as string; sequence = body.sequence; atMs = body.atMs
      events.push({ ...body, hash: previousHash })
    }
    else {
      diagnosticKeys(p, ['kind', 'atMs', 'attempted', 'written', 'droppedQueue', 'droppedCapacity', 'droppedStorage', 'reason', 'previousHash', 'hash'])
      const body = { kind: 'end' as const, atMs: diagnosticTime(p.atMs), attempted: diagnosticInteger(p.attempted), written: diagnosticInteger(p.written), droppedQueue: diagnosticInteger(p.droppedQueue), droppedCapacity: diagnosticInteger(p.droppedCapacity), droppedStorage: diagnosticInteger(p.droppedStorage), reason: p.reason as DiagnosticFooter['reason'], previousHash }
      if (p.kind !== 'end' || !['completed', 'interrupted', 'host-error'].includes(body.reason) || body.atMs < atMs || body.attempted < sequence || body.written !== events.length || body.attempted - body.written !== body.droppedQueue + body.droppedCapacity + body.droppedStorage) throw new TypeError('Diagnostic completion/loss accounting invalid')
      if (await hashDiagnostic(JSON.stringify(body)) !== diagnosticHash(p.hash)) throw new TypeError('Diagnostic completion digest mismatch')
      previousHash = p.hash as string; footer = { ...body, hash: previousHash }
    }
  }
  if (footer && tail) throw new TypeError('Trailing bytes after completed journal')
  return { header, events, footer, completion: footer?.reason ?? 'unfinalized', loss: { knownDropped: footer ? footer.attempted - footer.written : sequence - events.length, tailUnknown: !footer }, verifiedHash: previousHash, discardedTailBytes: new TextEncoder().encode(tail).length }
}
