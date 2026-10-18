import { beforeAll, describe, expect, test } from 'bun:test'
import fixtures from '../fixtures/runtime/frames.json'
import { commandFrame, decodeRuntimeFrame, encodeRuntimeFrame, runtimeCrc32, type RuntimeFrame } from '../../resources/functions/drone/runtime/protocol'
import { createRuntimeSession } from '../../resources/functions/drone/runtime/session'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { openRuntimeHarness } from '../../resources/functions/drone/runtime/harness'
import { runRuntimeBench, runtimeBenchFaults } from '../../resources/functions/drone/runtime/bench'
import { inspectRuntimeCapture } from '../../resources/functions/drone/runtime/capture'

const statusFrame = (overrides: Partial<RuntimeFrame> = {}): RuntimeFrame => ({ ...commandFrame('hello', 1, 12n, 77n), kind: 'status', sampleTimeUs: 1000n, ticks: 1, sample: -999, flags: 67, stateBytes: 88, ...overrides })

describe('owned runtime wire boundary', () => {
  test('uses independent Python/zlib little-endian fixtures and the standard CRC32 vector', () => {
    expect(runtimeCrc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const bytes = encodeRuntimeFrame(commandFrame('hello', 1, 0n, 0x0102030405060708n))
    expect(Buffer.from(bytes).toString('hex')).toBe(fixtures.frames.hello)
    const status = decodeRuntimeFrame(Uint8Array.fromHex(fixtures.frames.status))
    expect(status).toMatchObject({ bootId: 0x1122334455667788n, sampleTimeUs: 100000n, sample: -900, ticks: 100, maxExecutionUs: 123, stateBytes: 88 })
  })
  test('rejects malformed lengths, protocol versions, CRCs and numeric overflow', () => {
    const good = Uint8Array.fromHex(fixtures.frames.status)
    for (const bytes of [good.subarray(0, 63), new Uint8Array(65), good.with(2, 2), good.with(40, 0), good.with(3, 5)])
      expect(() => decodeRuntimeFrame(bytes)).toThrow()
    for (const bad of [{ sequence: -1 }, { bootId: -1n }, { sessionId: 1n << 64n }, { sample: Infinity }, { leaseUs: 2 ** 32 }, { kind: 'toString' as RuntimeFrame['kind'] }])
      expect(() => encodeRuntimeFrame(statusFrame(bad))).toThrow()
  })
  test('decodes a frame held at a nonzero typed-array offset', () => {
    const storage = new Uint8Array(80)
    storage.set(Uint8Array.fromHex(fixtures.frames.status), 8)
    expect(decodeRuntimeFrame(storage.subarray(8, 72)).sample).toBe(-900)
  })
  test('receive-only captures resynchronize around corruption and partial frames', () => {
    const frame = Uint8Array.fromHex(fixtures.frames.status)
    const capture = new Uint8Array(3 + 64 * 3 + 8)
    capture.set(frame, 3); capture.set(frame.with(2, 2), 67); capture.set(frame, 131)
    const report = inspectRuntimeCapture(capture)
    expect(report).toMatchObject({ frames: 2, corruptCandidates: 1, discardedBytes: 75, observedBootSegments: 1, physicalFlightEnabled: false })
    expect(() => inspectRuntimeCapture(new Uint8Array(1048577))).toThrow('1 MiB')
    expect(() => inspectRuntimeCapture(new Uint8Array(64))).toThrow('No compatible')
  })
})

describe('Pi bench session authority', () => {
  test('requires a matching boot handshake and fresh progressing samples before a lease', () => {
    const link = createRuntimeSession({ nonce: () => 77n })
    expect(() => link.lease(0)).toThrow()
    link.hello(0)
    link.accept(encodeRuntimeFrame(statusFrame()), 1)
    expect(decodeRuntimeFrame(link.lease(2)).bootId).toBe(12n)
    link.accept(encodeRuntimeFrame(statusFrame({ sequence: 2 })), 50)
    expect(() => link.lease(52)).toThrow('stale') // Repeated sample with a new packet sequence does not refresh it.
  })
  test('rejects changed boot/session, replay, faults and unsupported capabilities', () => {
    for (const invalid of [{ bootId: 13n }, { sessionId: 78n }, { sequence: 1 }, { flags: 75 }, { flags: 83 }, { flags: 195 }, { flags: 66 }, { stateBytes: 129 }, { ticks: 0 }, { sampleTimeUs: 999n }, { sampleTimeUs: 2000n }, { ticks: 2 }]) {
      const link = createRuntimeSession({ nonce: () => 77n })
      link.hello(0); link.accept(encodeRuntimeFrame(statusFrame()), 1)
      expect(() => link.accept(encodeRuntimeFrame(statusFrame({ sequence: 2, ...invalid })), 2)).toThrow()
      expect(link.snapshot().phase).toBe('lost')
      expect(() => link.lease(2)).toThrow()
    }
  })
  test('stop revokes local authority and a new hello needs a new nonce', () => {
    const link = createRuntimeSession({ nonce: () => 77n })
    link.hello(0); link.accept(encodeRuntimeFrame(statusFrame()), 1)
    expect(decodeRuntimeFrame(link.stop(2)).kind).toBe('stop')
    expect(link.snapshot().phase).toBe('idle')
    expect(() => link.lease(2)).toThrow()
    expect(() => link.hello(3)).toThrow('fresh')
  })
  test('clock reversal, invalid lease bounds and corrupt status fail closed', () => {
    for (const action of [(link: ReturnType<typeof createRuntimeSession>) => link.lease(0), (link: ReturnType<typeof createRuntimeSession>) => link.lease(2, 100001), (link: ReturnType<typeof createRuntimeSession>) => link.accept(new Uint8Array(64), 2)]) {
      const link = createRuntimeSession({ nonce: () => 77n })
      link.hello(0); link.accept(encodeRuntimeFrame(statusFrame()), 1)
      expect(() => action(link)).toThrow()
      expect(link.snapshot().phase).toBe('lost')
    }
  })
})

let artifact: string
beforeAll(async () => { artifact = (await buildRuntime()).artifact }, 20000)
async function withNative(run: (harness: ReturnType<typeof openRuntimeHarness>) => Promise<void>) {
  const harness = openRuntimeHarness(artifact)
  try { await run(harness) }
  finally { await harness.close() }
}

describe('actual native kernel process', () => {
  test('reports timestamped samples and cross-language handshake/lease/stop', async () => withNative(async harness => {
    const first = await harness.exchange('tick 1000')
    expect(first).toMatchObject({ ticks: 1, sample: -999, sampleTimeUs: 1000n, flags: 67 })
    const link = createRuntimeSession({ nonce: () => 45n })
    const send = (bytes: Uint8Array) => harness.exchange(`frame ${Buffer.from(bytes).toString('hex')}`)
    const hello = await send(link.hello(1)); link.accept(encodeRuntimeFrame(hello), 1)
    expect(hello.bootId).toBe(0x1122334455667788n)
    const lease = await send(link.lease(1)); link.accept(encodeRuntimeFrame(lease), 1)
    expect(lease.leaseUs).toBe(100000)
    expect((await send(link.stop(1))).leaseUs).toBe(0)
  }))
  test('a newer sequence cannot renew authority from an old board timestamp', async () => withNative(async harness => {
    await harness.exchange('tick 1000')
    const link = createRuntimeSession({ nonce: () => 45n })
    const send = (bytes: Uint8Array) => harness.exchange(`frame ${Buffer.from(bytes).toString('hex')}`)
    const hello = await send(link.hello(1)); link.accept(encodeRuntimeFrame(hello), 1)
    expect((await send(link.lease(1))).leaseUs).toBe(100000)
    for (let time = 2000; time <= 52000; time += 1000) await harness.exchange(`tick ${time}`)
    const stale = await send(encodeRuntimeFrame(commandFrame('lease', 3, hello.bootId, 45n, 1000n, 100000)))
    expect(stale.leaseUs).toBe(0)
    expect(stale.sessionId).toBe(0n)
  }))
  test('an incompatible version revokes the native session even with a valid CRC', async () => withNative(async harness => {
    await harness.exchange('tick 1000')
    const link = createRuntimeSession({ nonce: () => 45n })
    const send = (bytes: Uint8Array) => harness.exchange(`frame ${Buffer.from(bytes).toString('hex')}`)
    const hello = await send(link.hello(1)); link.accept(encodeRuntimeFrame(hello), 1)
    await send(link.lease(1))
    const wrong = encodeRuntimeFrame(commandFrame('lease', 3, hello.bootId, 45n, 1000n, 100000)); wrong[2] = 2
    new DataView(wrong.buffer).setUint32(60, runtimeCrc32(wrong.subarray(0, 60)), true)
    const rejected = await send(wrong)
    expect(rejected.sessionId).toBe(0n)
    expect(rejected.leaseUs).toBe(0)
  }))
  test('bench scenarios exercise the native failure paths and identify host evidence', async () => {
    for (const fault of runtimeBenchFaults) {
      const report = await runRuntimeBench({ ticks: 25, fault })
      expect(report).toMatchObject({ evidence: 'host-harness', fault, neutralOnly: true, leaseActive: false, physicalFlightEnabled: false })
      expect(report.stateBytes).toBeLessThanOrEqual(128)
      expect(report.deadlineMisses).toBe(fault === 'deadline' ? 1 : 0)
    }
  }, 20000)
  test('invalid CLI parameters cannot silently execute a default bench run', async () => {
    const child = Bun.spawn([process.execPath, 'bin/drone.ts', 'runtime:bench', '--ticks', 'nan'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('1..100000')
  })
  test('the harness rejects concurrent requests and reports early process exit', async () => {
    await withNative(async harness => {
      const pending = harness.exchange('tick 1000')
      await expect(harness.exchange('tick 2000')).rejects.toThrow('concurrent')
      expect((await pending).ticks).toBe(1)
      await expect(harness.exchange('not-a-host-command')).rejects.toThrow('exited')
    })
  })
})
