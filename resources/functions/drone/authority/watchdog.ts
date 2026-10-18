import type { Motors } from '../controls/model'
import type { SimulatedActuatorFrame } from './supervisor'
import { validMotors } from './supervisor'
import { createOutputWatchdogKernel } from './watchdog-core'
/** Strict legacy quad-X view of the shared independent board lease kernel. */
export function createSimulatedOutputWatchdog(options: { bootId: bigint, sessionId: bigint }) {
  const core = createOutputWatchdogKernel<SimulatedActuatorFrame>({ ...options, neutral: [0, 0, 0, 0], valid: frame => validMotors(frame.motorsN), values: frame => frame.motorsN })
  function snapshot() {
    const s = core.snapshot()
    return { bootId: s.bootId, lastCheckedAtMs: s.lastCheckedAtMs, sequence: s.sequence, epoch: s.epoch, expiresAtMs: s.expiresAtMs, motorsN: s.values as Motors, fault: s.fault, physicalFlightEnabled: s.physicalFlightEnabled, boardOutputsInhibited: s.boardOutputsInhibited }
  }
  return { snapshot, tick(nowMs: number) { core.tick(nowMs); return snapshot() }, accept: core.accept, revoke: core.revoke, trip: core.trip, reboot: core.reboot }
}
