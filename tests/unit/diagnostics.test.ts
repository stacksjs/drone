import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDiagnosticsRecorder } from '../../resources/functions/drone/diagnostics/recorder'
import { parseDiagnosticsJournal } from '../../resources/functions/drone/diagnostics/journal'

const provenance = { firmwareSha256: '1'.repeat(64), configurationSha256: '2'.repeat(64), modelSha256: '3'.repeat(64), calibrationSha256: '4'.repeat(64), runtimeProtocol: 1 as const }
test('an interrupted journal recovers verified records and reports an unknown tail instead of a clean mission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-'))
  try {
    const recorder = await openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance })
    recorder.append({ kind: 'health', code: 'transport-loss' }, 10)
    await recorder.flush()
    await recorder.close('interrupted')
    const text = await readFile(join(root, 'run/journal.ndjson'), 'utf8'), lines = text.trimEnd().split('\n')
    const recovered = await parseDiagnosticsJournal(`${lines.slice(0, -1).join('\n')}\n{"incomplete":`)
    expect(recovered.completion).toBe('unfinalized')
    expect(recovered.events).toHaveLength(1)
    expect(recovered.loss.tailUnknown).toBe(true)
    expect(recovered.events[0]!.event).toEqual({ kind: 'health', code: 'transport-loss' })
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

import { createDiagnosticsReplay, diagnoseDiagnostics } from '../../resources/functions/drone/diagnostics/replay'
import { recordRuntimeFrame } from '../../resources/functions/drone/diagnostics/journal'
import { commandFrame, runtimeFlags } from '../../resources/functions/drone/runtime/protocol'
import { readDiagnosticsFile, exportDiagnostics } from '../../resources/functions/drone/diagnostics/files'

const status = (sequence: number, sampleTimeUs: bigint, flags = 67) => ({ ...commandFrame('hello', sequence, 123n, 456n), kind: 'status' as const, ticks: sequence, sampleTimeUs, flags, stateBytes: 128, maxExecutionUs: 100 })
test('replay preserves command/status epochs, diagnoses deadline/reset events and is independent of playback chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-replay-'))
  try {
    const writer = await openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance })
    writer.append({ kind: 'runtime', direction: 'tx', frame: recordRuntimeFrame(commandFrame('hello', 1, 0n, 456n)) }, 0)
    writer.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(status(1, 1000n)) }, 1)
    await writer.flush()
    writer.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(status(2, 3000n, 67 | runtimeFlags.deadlineFault)) }, 3)
    writer.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame({ ...status(1, 100n, 67 | runtimeFlags.watchdogReset), bootId: 124n }) }, 4)
    await writer.close()
    const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(writer.path)), replay = createDiagnosticsReplay(journal), other = createDiagnosticsReplay(journal)
    expect(replay.advanceTo(2).latest!.sequence).toBe(1)
    expect(replay.advanceTo(3).health).toContain('deadline-miss')
    expect(replay.advanceTo(4)).toEqual(other.advanceTo(4))
    expect(replay.snapshot().health).toEqual(['deadline-miss', 'boot-change', 'watchdog-reset'])
    expect(replay.snapshot().bootSegments).toBe(2)
    expect(replay.snapshot().commands).toBe(1)
    expect(replay.advanceTo(55).statusStale).toBe(true)
    expect(() => replay.advanceTo(54)).toThrow('monotonically')
    replay.snapshot().latest!.bootId = '999'
    expect(replay.snapshot().latest!.bootId).toBe('124')
    expect(diagnoseDiagnostics(journal).commissioningReady).toBe(false)
    expect(diagnoseDiagnostics(journal).diagnosticFailures).toBe(1)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('bounded queue and capacity drops are counted exactly, including the discarded final attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-loss-'))
  try {
    const writer = await openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance, queueDepth: 1, maxEvents: 2 })
    expect(writer.append({ kind: 'health', code: 'transport-loss' }, 0)).toBe(true)
    expect(writer.append({ kind: 'health', code: 'host-error' }, 1)).toBe(false)
    await writer.flush()
    writer.append({ kind: 'health', code: 'watchdog-reset' }, 2); await writer.flush()
    writer.append({ kind: 'health', code: 'deadline-miss' }, 3); await writer.flush()
    await writer.close()
    const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(writer.path))
    expect(journal.events.map(e => e.sequence)).toEqual([1, 3])
    expect(journal.footer).toMatchObject({ attempted: 4, written: 2, droppedQueue: 1, droppedCapacity: 1 })
    expect(journal.loss).toEqual({ knownDropped: 2, tailUnknown: false })
    expect(() => writer.append({ kind: 'health', code: 'host-error' }, 4)).toThrow('closed')
    await expect(writer.close()).rejects.toThrow('closed')
    const capped = await openDiagnosticsRecorder({ directory: join(root, 'capped'), evidence: 'fixture', provenance, maxBytes: 8192 })
    for (let i = 0; i < 100; i++) { capped.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(status(i + 1, BigInt(i * 1000))) }, i); await capped.flush({ sync: false }) }
    await capped.close()
    const bounded = await parseDiagnosticsJournal(await readDiagnosticsFile(capped.path))
    expect(new TextEncoder().encode(await readDiagnosticsFile(capped.path)).length).toBeLessThanOrEqual(8192)
    expect(bounded.footer!.droppedCapacity).toBeGreaterThan(0)
    expect(bounded.footer!.attempted).toBe(100)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

import { hashDiagnostic, sealDiagnostic } from '../../resources/functions/drone/diagnostics/journal'
import { stat, symlink } from 'node:fs/promises'
import { loadDiagnosticFile } from '../../resources/functions/drone/diagnostics/client'

test('journals reject tampering, unsupported fields, invalid provenance and malformed completion accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-corrupt-'))
  try {
    const writer = await openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance })
    expect(() => writer.append({ kind: 'health', code: 'host-error', token: 'secret-operator-token' } as never, 0)).toThrow('private')
    expect(() => writer.append({ kind: 'health', code: '<script>alert(1)</script>' } as never, 0)).toThrow()
    expect(() => writer.append({ kind: 'tick', boardUs: '-1' }, 0)).toThrow()
    writer.append({ kind: 'health', code: 'deadline-miss' }, 2)
    expect(() => writer.append({ kind: 'health', code: 'host-error' }, 1)).toThrow('clock')
    await writer.close()
    const text = await readDiagnosticsFile(writer.path), lines = text.trimEnd().split('\n')
    expect(text).not.toContain('secret-operator-token')
    await expect(parseDiagnosticsJournal(text.replace('deadline-miss', 'transport-loss'))).rejects.toThrow('digest')
    await expect(parseDiagnosticsJournal(text.replace('"sequence":1', '"sequence":0'))).rejects.toThrow()
    await expect(parseDiagnosticsJournal(`${text}trailing`)).rejects.toThrow('Trailing')
    await expect(parseDiagnosticsJournal(`${text}\n`)).rejects.toThrow('lines')
    const row = JSON.parse(lines[1]!); row.sequence = 2
    const { hash, ...body } = row; void hash
    const updated = await sealDiagnostic(body), footer = JSON.parse(lines[2]!)
    footer.previousHash = updated.hash; footer.attempted = 2
    const { hash: footerHash, ...footerBody } = footer; void footerHash
    await expect(parseDiagnosticsJournal(`${lines[0]}\n${JSON.stringify(updated)}\n${JSON.stringify(await sealDiagnostic(footerBody))}\n`)).rejects.toThrow('accounting')
    await expect(openDiagnosticsRecorder({ directory: join(root, 'bad'), evidence: 'fixture', provenance: { ...provenance, firmwareSha256: 'unknown' } })).rejects.toThrow('digest')
    await expect(openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance })).rejects.toThrow('EEXIST')
    await expect(parseDiagnosticsJournal('x'.repeat(4194305))).rejects.toThrow('4 MiB')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('schema-verified export preserves hash and losses, refuses overwrite and does not follow final symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-export-'))
  try {
    const writer = await openDiagnosticsRecorder({ directory: join(root, 'run'), evidence: 'fixture', provenance })
    writer.append({ kind: 'health', code: 'transport-loss' }, 0); await writer.close()
    const exported = await exportDiagnostics(writer.path, join(root, 'export')), text = await readDiagnosticsFile(exported.path)
    expect(exported.sha256).toBe(await hashDiagnostic(text))
    expect((await parseDiagnosticsJournal(text)).loss).toEqual({ knownDropped: 0, tailUnknown: false })
    expect((await stat(exported.path)).mode & 0o777).toBe(0o600)
    await expect(exportDiagnostics(writer.path, join(root, 'export'))).rejects.toThrow('EEXIST')
    await symlink(writer.path, join(root, 'link'))
    await expect(readDiagnosticsFile(join(root, 'link'))).rejects.toThrow()
    await expect(readDiagnosticsFile(join(root, 'export'))).rejects.toThrow('regular')
    expect((await loadDiagnosticFile({ size: new TextEncoder().encode(text).length, text: async () => text })).completion).toBe('completed')
    await expect(loadDiagnosticFile({ size: 4194305, text: async () => '' })).rejects.toThrow('4 MiB')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('a killed recorder leaves a recoverable, durable prefix without pretending the tail was accounted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-crash-'))
  const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${join(import.meta.dir, '../fixtures/process/bunfig.toml')}`, join(import.meta.dir, '../fixtures/diagnostics/crash.ts'), join(root, 'run')], { stdout: 'pipe', stderr: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  try {
    const reader = child.stdout.getReader(), first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('ready')
    child.kill('SIGKILL'); await child.exited; await reader.cancel(); reader.releaseLock()
    const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(join(root, 'run/journal.ndjson')))
    expect(journal.completion).toBe('unfinalized'); expect(journal.events).toHaveLength(1); expect(journal.loss.tailUnknown).toBe(true)
    const exported = await exportDiagnostics(join(root, 'run/journal.ndjson'), join(root, 'recover'))
    expect(exported.completion).toBe('unfinalized'); expect(exported.loss.tailUnknown).toBe(true)
  }
  finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; await rm(root, { recursive: true, force: true }) }
}, 60000)

import { recordRuntimeDiagnostics } from '../../resources/functions/drone/diagnostics/bench'
import { command as cliCommand } from '@stacksjs/testing'
test('native runtime recording reproduces the actual deadline and protocol rejection without commanding a vehicle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-native-'))
  try {
    for (const fault of ['none', 'deadline', 'version'] as const) {
      const result = await recordRuntimeDiagnostics({ directory: join(root, fault), ticks: 20, fault, project: join(import.meta.dir, '../..') })
      expect(result.diagnostics.replay.latest!.ticks).toBe(result.bench.ticks)
      expect(result.diagnostics.replay.latest!.deadlineMisses).toBe(result.bench.deadlineMisses)
      expect(result.diagnostics.replay.loss).toEqual({ knownDropped: 0, tailUnknown: false })
      expect(result.diagnostics.replay.health).toEqual(fault === 'deadline' ? ['deadline-miss'] : fault === 'version' ? ['protocol-rejected'] : [])
      expect(result.diagnostics.commissioningReady).toBe(false)
      const first = await cliCommand(['diagnostics:replay', result.path, '--at-ms', '1']).withTimeout(60000)
      expect(first.exitCode).toBe(0); expect(JSON.parse(first.stdout).latest.ticks).toBe(1)
    }
    const inspected = await cliCommand(['diagnostics:inspect', join(root, 'deadline/journal.ndjson'), '--check']).withTimeout(60000)
    expect(inspected.exitCode).toBe(1)
    expect(JSON.parse(inspected.stdout).replay.health).toContain('deadline-miss')
    expect((await cliCommand(['diagnostics:inspect', join(root, 'none/journal.ndjson'), '--check']).withTimeout(60000)).exitCode).toBe(0)
    expect((await cliCommand(['diagnostics:replay', join(root, 'none/journal.ndjson'), '--at-ms', 'nan']).withTimeout(60000)).exitCode).toBe(1)
    const exported = await cliCommand(['diagnostics:export', join(root, 'none/journal.ndjson'), '--output', join(root, 'export')]).withTimeout(60000)
    expect(exported.exitCode).toBe(0)
    expect((await parseDiagnosticsJournal(await readDiagnosticsFile(join(root, 'export/journal.ndjson')))).completion).toBe('completed')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

test('retained runtime example shows the deadline at 22 ms and does not expose it before that epoch', async () => {
  const text = await readDiagnosticsFile(join(import.meta.dir, '../../public/diagnostics/runtime-deadline.ndjson'))
  const journal = await parseDiagnosticsJournal(text), replay = createDiagnosticsReplay(journal)
  expect(replay.advanceTo(20).health).toEqual([])
  expect(replay.advanceTo(22).health).toEqual(['deadline-miss'])
  expect(replay.snapshot().latest!.ticks).toBe(20)
  expect(journal.events).toHaveLength(46)
})

import type { DiagnosticHeader } from '../../resources/functions/drone/diagnostics/types'
import type { DiagnosticStorage } from '../../resources/functions/drone/diagnostics/recorder'
import { createDiagnosticsRecorder } from '../../resources/functions/drone/diagnostics/recorder'
import { validateDiagnosticHeader, validateDiagnosticEvent } from '../../resources/functions/drone/diagnostics/journal'

const storageHeader = (): DiagnosticHeader => ({ kind: 'header', format: 'drone-diagnostics', version: 1, runId: crypto.randomUUID(), evidence: 'fixture', provenance, maxBytes: 4194304, maxEvents: 4096, privacy: 'runtime-only', physicalFlightEnabled: false })
class ByteStorage implements DiagnosticStorage {
  bytes: number[] = []
  closed = 0
  shortWrites = false
  failure: 'none' | 'ENOSPC' | 'EDQUOT' | 'EIO' | 'zero' | 'partial' = 'none'
  syncFailure = false
  async write(buffer: Uint8Array, offset: number, length: number) {
    if (this.failure === 'zero') return 0
    if (['ENOSPC', 'EDQUOT', 'EIO'].includes(this.failure)) throw Object.assign(new Error('Injected external storage failure'), { code: this.failure })
    const count = Math.min(length, this.shortWrites ? 7 : this.failure === 'partial' ? 13 : length)
    this.bytes.push(...buffer.subarray(offset, offset + count))
    if (this.failure === 'partial') this.failure = 'ENOSPC'
    return count
  }
  async sync() { if (this.syncFailure) throw Object.assign(new Error('Injected sync failure'), { code: 'EIO' }) }
  async close() { this.closed++ }
  text() { return new TextDecoder().decode(new Uint8Array(this.bytes)) }
}

test('the public storage boundary handles short writes, full media, zero progress and partial failed records', async () => {
  const short = new ByteStorage(); short.shortWrites = true
  const writer = await createDiagnosticsRecorder({ header: storageHeader(), storage: short })
  writer.append({ kind: 'health', code: 'deadline-miss' }, 1); await writer.close()
  expect(short.closed).toBe(1)
  expect((await parseDiagnosticsJournal(short.text())).events).toHaveLength(1)
  for (const fault of ['ENOSPC', 'EDQUOT', 'EIO', 'zero', 'partial'] as const) {
    const storage = new ByteStorage(), recorder = await createDiagnosticsRecorder({ header: storageHeader(), storage })
    storage.failure = fault
    recorder.append({ kind: 'health', code: 'transport-loss' }, 1)
    const state = await recorder.flush()
    expect(state.storageFault).toBe(['EIO', 'zero'].includes(fault) ? 'io' : 'full')
    expect(state.droppedStorage).toBe(1)
    expect(recorder.append({ kind: 'health', code: 'host-error' }, 2)).toBe(false)
    await expect(recorder.close()).rejects.toThrow('storage failed')
    expect(storage.closed).toBe(1)
    expect(recorder.stats().droppedStorage).toBe(2)
    const recovered = await parseDiagnosticsJournal(storage.text())
    expect(recovered.completion).toBe('unfinalized'); expect(recovered.loss.tailUnknown).toBe(true)
    expect(recovered.discardedTailBytes).toBe(fault === 'partial' ? 13 : 0)
  }
})

test('storage startup, flush and completion sync failures reject and close owned descriptors', async () => {
  const startup = new ByteStorage(); startup.syncFailure = true
  await expect(createDiagnosticsRecorder({ header: storageHeader(), storage: startup })).rejects.toThrow('sync')
  expect(startup.closed).toBe(1)
  const storage = new ByteStorage(), writer = await createDiagnosticsRecorder({ header: storageHeader(), storage })
  writer.append({ kind: 'health', code: 'transport-loss' }, 1); await writer.flush({ sync: false })
  storage.syncFailure = true
  await expect(writer.flush()).rejects.toThrow('sync')
  expect(writer.stats().storageFault).toBe('io')
  await expect(writer.close()).rejects.toThrow('storage failed'); expect(storage.closed).toBe(1)
  expect((await parseDiagnosticsJournal(storage.text())).completion).toBe('unfinalized')
  const closing = new ByteStorage(), last = await createDiagnosticsRecorder({ header: storageHeader(), storage: closing })
  last.append({ kind: 'health', code: 'transport-loss' }, 1); await last.flush({ sync: false })
  closing.syncFailure = true
  await expect(last.close()).rejects.toThrow('sync'); expect(closing.closed).toBe(1); expect(last.stats().storageFault).toBe('io')
  // A logical completion record does not attest that a later fsync succeeded.
  expect((await parseDiagnosticsJournal(closing.text())).completion).toBe('completed')
})

test('strict enum validation rejects arrays and objects before opaque command data can bypass privacy checks', () => {
  for (const evidence of [['fixture'], { toString: () => 'fixture' }]) expect(() => validateDiagnosticHeader({ ...storageHeader(), evidence })).toThrow('header')
  for (const direction of [['tx'], { toString: () => 'tx' }]) {
    expect(() => validateDiagnosticEvent({ kind: 'runtime', direction, frame: recordRuntimeFrame({ ...commandFrame('lease', 1, 1n, 2n), sample: 123 }) })).toThrow()
  }
  for (const kind of [['hello'], { toString: () => 'hello' }]) expect(() => validateDiagnosticEvent({ kind: 'runtime', direction: 'tx', frame: { ...recordRuntimeFrame(commandFrame('hello', 1, 1n, 2n)), kind } })).toThrow('kind')
})

test('reordered and duplicate statuses do not reset a boot sequence high-water mark or invent gaps and clock reversals', async () => {
  const storage = new ByteStorage(), writer = await createDiagnosticsRecorder({ header: storageHeader(), storage })
  for (const [at, sequence] of [10, 9, 11, 11, 12].entries()) { writer.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(status(sequence, BigInt(sequence * 1000))) }, at); await writer.flush({ sync: false }) }
  await writer.close()
  const journal = await parseDiagnosticsJournal(storage.text()), replay = createDiagnosticsReplay(journal).advanceTo(4)
  expect(replay.wireGaps).toBe(0); expect(replay.replayedStatus).toBe(2); expect(replay.health).toEqual(['status-replay'])
})

test('regular-file input rejects devices and named pipes without waiting for a writer', async () => {
  await expect(readDiagnosticsFile('/dev/null')).rejects.toThrow('regular')
  const root = await mkdtemp(join(tmpdir(), 'drone-diagnostics-fifo-'))
  try {
    const path = join(root, 'pipe')
    expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0)
    await expect(readDiagnosticsFile(path)).rejects.toThrow('regular')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('malformed imported JSON never reflects private source snippets into diagnostic errors', async () => {
  const header = JSON.stringify(storageHeader())
  try { await parseDiagnosticsJournal(`${header}\n{"operatorToken":"private-fixture-secret",invalid}\n`); throw new Error('Expected malformed input to fail') }
  catch (error) { expect((error as Error).message).toBe('Malformed diagnostic JSON line'); expect((error as Error).message).not.toContain('private-fixture-secret') }
})

test('schema-valid but unhealthy runtime status is retained and fails diagnostic commissioning checks', async () => {
  const storage = new ByteStorage(), writer = await createDiagnosticsRecorder({ header: storageHeader(), storage })
  const frame = { ...status(0, 0n, 3), bootId: 0n, stateBytes: 256, leaseUs: 200000 }
  writer.append({ kind: 'runtime', direction: 'rx', frame: recordRuntimeFrame(frame) }, 0); await writer.close()
  const journal = await parseDiagnosticsJournal(storage.text()), report = diagnoseDiagnostics(journal)
  expect(report.replay.health).toEqual(['invalid-runtime-identity', 'runtime-sample-invalid', 'runtime-state-bounds', 'lease-inconsistent'])
  expect(report.diagnosticFailures).toBe(1)
  expect(journal.events[0]!.event.kind).toBe('runtime')
})
