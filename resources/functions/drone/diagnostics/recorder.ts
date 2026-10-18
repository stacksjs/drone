import type { DiagnosticEvent, DiagnosticHeader, DiagnosticProvenance, DiagnosticFooter } from './types'
import { mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { diagnosticLimits } from './types'
import { diagnosticInteger, diagnosticTime, hashDiagnostic, sealDiagnostic, validateDiagnosticEvent, validateDiagnosticHeader } from './journal'

/** External byte-storage boundary. A valid recorder owns close after admission, including startup failures. */
export interface DiagnosticStorage {
  write: (buffer: Uint8Array, offset: number, length: number) => Promise<number>
  sync: () => Promise<void>
  close: () => Promise<void>
}
function storageFaultKind(error: unknown): 'full' | 'io' {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT' ? 'full' : 'io'
}
export async function createDiagnosticsRecorder(options: { header: DiagnosticHeader, storage: DiagnosticStorage, queueDepth?: number }) {
  const header = validateDiagnosticHeader(options.header), depth = diagnosticInteger(options.queueDepth ?? diagnosticLimits.queue, 1, 64)
  const storage = { write: options.storage.write.bind(options.storage), sync: options.storage.sync.bind(options.storage), close: options.storage.close.bind(options.storage) }
  let bytes = 0, previousHash = '', lastAtMs = 0, attempted = 0, written = 0, droppedQueue = 0, droppedCapacity = 0, droppedStorage = 0
  let accepting = true, storageFault: 'full' | 'io' | null = null, draining: Promise<void> | null = null, inFlight = false
  const queue: { sequence: number, atMs: number, event: DiagnosticEvent }[] = []
  async function write(line: string) {
    const buffer = new TextEncoder().encode(`${line}\n`)
    for (let offset = 0; offset < buffer.length;) {
      const bytesWritten = await storage.write(buffer, offset, buffer.length - offset)
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw new Error('No diagnostic write progress')
      offset += bytesWritten
    }
    bytes += buffer.length
  }
  try { previousHash = await hashDiagnostic(JSON.stringify(header)); await write(JSON.stringify(header)); await storage.sync() }
  catch (error) { await storage.close(); throw error }
  function stats() { return { attempted, written, droppedQueue, droppedCapacity, droppedStorage, queued: queue.length + Number(inFlight), lastAtMs, bytes, storageFault, accepting } }
  async function drain() {
    while (queue.length) {
      const item = queue.shift()!
      inFlight = true
      try {
        const entry = await sealDiagnostic({ kind: 'event' as const, ...item, previousHash })
        const line = JSON.stringify(entry)
        if (written >= header.maxEvents || bytes + new TextEncoder().encode(line).length + 1 > header.maxBytes - diagnosticLimits.footerReserveBytes) { droppedCapacity++; continue }
        await write(line)
        previousHash = entry.hash; written++
      }
      catch (error) {
        storageFault = storageFaultKind(error)
        droppedStorage += queue.length + 1; queue.length = 0
      }
      finally { inFlight = false }
    }
  }
  function schedule() { if (!draining) { draining = drain().finally(() => { draining = null; if (queue.length) schedule() }) } }
  return {
    header: structuredClone(header), stats,
    append(input: DiagnosticEvent, atMs: number): boolean {
      if (!accepting) throw new Error('Diagnostic recorder is closed')
      const event = validateDiagnosticEvent(input), at = diagnosticTime(atMs)
      if (at < lastAtMs || attempted >= 0xFFFFFFFF) throw new RangeError('Diagnostic clock or sequence discontinuity')
      lastAtMs = at; attempted++
      if (storageFault) { droppedStorage++; return false }
      if (queue.length + Number(inFlight) >= depth) { droppedQueue++; return false }
      queue.push({ sequence: attempted, atMs: at, event }); schedule(); return true
    },
    async flush(options: { sync?: boolean } = {}) {
      while (draining) await draining
      if (!storageFault && options.sync !== false) {
        try { await storage.sync() }
        catch (error) { storageFault = storageFaultKind(error); throw error }
      }
      return stats()
    },
    async close(reason: DiagnosticFooter['reason'] = 'completed') {
      if (!accepting) throw new Error('Diagnostic recorder already closed')
      if (!['completed', 'interrupted', 'host-error'].includes(reason)) throw new TypeError('Invalid diagnostic completion reason')
      accepting = false
      try {
        while (draining) await draining
        if (storageFault) throw new Error('Diagnostic storage failed; recover the verified prefix')
        const footer = await sealDiagnostic({ kind: 'end' as const, atMs: lastAtMs, attempted, written, droppedQueue, droppedCapacity, droppedStorage, reason, previousHash })
        const line = JSON.stringify(footer)
        if (new TextEncoder().encode(line).length + 1 > diagnosticLimits.footerReserveBytes) throw new Error('Diagnostic completion reserve exceeded')
        await write(line); await storage.sync()
        return stats()
      }
      catch (error) { storageFault ??= storageFaultKind(error); throw error }
      finally { await storage.close() }
    },
  }
}
/** Host-side exclusive local file adapter. Logging is outside the firmware tick and grants no authority. */
export async function openDiagnosticsRecorder(options: { directory: string, evidence: DiagnosticHeader['evidence'], provenance: DiagnosticProvenance, maxBytes?: number, maxEvents?: number, queueDepth?: number }) {
  const header = validateDiagnosticHeader({ kind: 'header', format: 'drone-diagnostics', version: 1, runId: crypto.randomUUID(), evidence: options.evidence, provenance: options.provenance, maxBytes: options.maxBytes ?? diagnosticLimits.fileBytes, maxEvents: options.maxEvents ?? diagnosticLimits.events, privacy: 'runtime-only', physicalFlightEnabled: false })
  const queueDepth = diagnosticInteger(options.queueDepth ?? diagnosticLimits.queue, 1, 64), directory = resolve(options.directory)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, 'journal.ndjson'), file = await open(path, 'wx', 0o600)
  const recorder = await createDiagnosticsRecorder({ header, queueDepth, storage: {
    async write(buffer, offset, length) { return (await file.write(buffer, offset, length)).bytesWritten },
    sync: () => file.sync(), close: () => file.close(),
  } })
  return { path, ...recorder }
}
export type DiagnosticsRecorder = Awaited<ReturnType<typeof openDiagnosticsRecorder>>
