import type { RuntimeFrame } from './protocol'
import { buildRuntime } from './build'
import { openRuntimeHarness } from './harness'
import { createRuntimeSession } from './session'
import { decodeRuntimeFrame, encodeRuntimeFrame, runtimeCrc32, runtimeFlags } from './protocol'

export const runtimeBenchFaults = ['none', 'deadline', 'stale', 'expiry', 'replay', 'version'] as const
export type RuntimeBenchFault = typeof runtimeBenchFaults[number]
export async function runRuntimeBench(options: { project?: string, ticks?: number, fault?: RuntimeBenchFault, onBuild?: (artifact: string) => Promise<void>, onRequest?: (line: string, atMs: number) => void | Promise<void>, onStatus?: (status: RuntimeFrame, atMs: number) => void | Promise<void> } = {}) {
  const ticks = options.ticks ?? 1000
  const fault = options.fault ?? 'none'
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 100000 || !runtimeBenchFaults.includes(fault)) throw new RangeError('Use 1..100000 ticks and a supported bench fault')
  const build = await buildRuntime({ project: options.project })
  await options.onBuild?.(build.artifact)
  const harness = openRuntimeHarness(build.artifact)
  const session = createRuntimeSession()
  const started = performance.now()
  let time = 1000
  async function exchange(line: string) {
    await options.onRequest?.(line, time / 1000)
    const status = await harness.exchange(line)
    await options.onStatus?.(status, time / 1000)
    return status
  }
  try {
    await exchange(`tick ${time}`)
    let status = await exchange(`frame ${Buffer.from(session.hello(time / 1000)).toString('hex')}`)
    session.accept(encodeRuntimeFrame(status), time / 1000)
    let lastLease = session.lease(time / 1000)
    status = await exchange(`frame ${Buffer.from(lastLease).toString('hex')}`)
    session.accept(encodeRuntimeFrame(status), time / 1000)
    for (let step = 1; step < ticks; step++) {
      time += 1000
      status = await exchange(`tick ${time}`)
      session.accept(encodeRuntimeFrame(status), time / 1000)
      if (step % 20 === 0) {
        lastLease = session.lease(time / 1000)
        status = await exchange(`frame ${Buffer.from(lastLease).toString('hex')}`)
        session.accept(encodeRuntimeFrame(status), time / 1000)
      }
    }
    if (fault === 'none') status = await exchange(`frame ${Buffer.from(session.stop(time / 1000)).toString('hex')}`)
    else if (fault === 'deadline') status = await exchange(`tick ${time += 2000}`)
    else if (fault === 'stale') {
      lastLease = session.lease(time / 1000)
      await exchange(`frame ${Buffer.from(lastLease).toString('hex')}`)
      for (let step = 0; step < 51; step++) status = await exchange(`tick ${time += 1000}`)
      if (status.leaseUs === 0) throw new Error('Freshness scenario requires an unexpired lease')
      const newer = decodeRuntimeFrame(lastLease); newer.sequence++
      status = await exchange(`frame ${Buffer.from(encodeRuntimeFrame(newer)).toString('hex')}`)
    }
    else if (fault === 'expiry') {
      for (let step = 0; step < 101; step++) status = await exchange(`tick ${time += 1000}`)
    }
    else if (fault === 'replay') status = await exchange(`frame ${Buffer.from(lastLease).toString('hex')}`)
    else {
      const incompatible = new Uint8Array(lastLease); incompatible[2] = 2
      new DataView(incompatible.buffer).setUint32(60, runtimeCrc32(incompatible.subarray(0, 60)), true)
      status = await exchange(`frame ${Buffer.from(incompatible).toString('hex')}`)
    }
    if ((status.flags & runtimeFlags.leased) || status.leaseUs !== 0 || (status.flags & 3) !== 3
      || (fault === 'deadline' && !(status.flags & runtimeFlags.deadlineFault))) throw new Error('Native bench failure did not return the required neutral-only, unleased state')
    return {
      evidence: 'host-harness', boardCandidate: 'pico2', protocolVersion: 1, fault,
      ticks: status.ticks, virtualElapsedUs: time, hostElapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      stateBytes: status.stateBytes, maxExecutionUs: status.maxExecutionUs, deadlineMisses: status.deadlineMisses,
      neutralOnly: true, leaseActive: false, physicalFlightEnabled: false,
      note: 'Host virtual-clock evidence. GPIO timing, stack high-water and hardware watchdog require a Pico 2 bench measurement.',
    }
  }
  finally { await harness.close() }
}
