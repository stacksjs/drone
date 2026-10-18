import type { AuthorityAction, AuthorityObservation } from '../../../resources/functions/drone/authority/supervisor'
import { createAuthoritySupervisor } from '../../../resources/functions/drone/authority/supervisor'
import { createSimulatedMultirotorController } from '../../../resources/functions/drone/controls/controller'
import { createEstimatorReplay } from '../../../resources/functions/drone/estimation/replay'
import motion from '../estimation/motion-v1.json'
const prototype = createEstimatorReplay(motion).advanceTo(1040).estimate
export function observation(nowMs = 1000): AuthorityObservation {
  const estimate = structuredClone(prototype)
  estimate.nowMs = nowMs; estimate.bootId = 55n
  estimate.attitude!.quaternionWxyz = [1, 0, 0, 0]; estimate.attitude!.capturedAtMs = nowMs
  estimate.localPosition!.positionM = [0, 0, -1]; estimate.localPosition!.velocityMps = [0, 0, 0]
  estimate.localPosition!.capturedAtMs = nowMs; estimate.localPosition!.predictedToMs = nowMs
  return { kind: 'simulation', nowMs, estimate, runtime: { bootId: 55n, capturedAtMs: nowMs, watchdogHealthy: true }, rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: false }, interlocks: { capturedAtMs: nowMs, killActive: false, onGround: true, motorsStopped: true }, battery: { capturedAtMs: nowMs, remainingPercent: 90 }, link: { capturedAtMs: nowMs, connected: true } }
}
export const supervisor = () => createAuthoritySupervisor({ sessionId: 123n, bootId: 55n })
export function command(s: ReturnType<typeof supervisor>, action: AuthorityAction, issuedAtMs = 1000) {
  const snapshot = s.snapshot()
  return { version: 1 as const, sessionId: 123n, bootId: 55n, epoch: snapshot.epoch, sequence: snapshot.sequence + 1, issuedAtMs, action, mode: 'position' as const, target: { positionM: [0, 0, -1] as [number, number, number], yawRad: 0 }, leaseMs: 100 }
}
export function engaged() {
  const s = supervisor()
  s.update(observation(), command(s, 'arm'))
  s.update(observation(), command(s, 'engage'))
  return s
}
export function output(nowMs = 1000) {
  return createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' }).step({ kind: 'simulation', nowMs, enabled: true, estimate: observation(nowMs).estimate, angularRateRadS: [0, 0, 0], rateCapturedAtMs: nowMs, target: { positionM: [0, 0, -1], yawRad: 0, issuedAtMs: nowMs } })
}
