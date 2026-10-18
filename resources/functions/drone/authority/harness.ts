import type { EstimatorSnapshot } from '../estimation/estimator'
import type { RigidBodyState } from '../controls/physics'
import type { SimulatedControlOutput } from '../controls/controller'
import type { AuthorityAction, AuthorityObservation, PositionTarget } from './supervisor'
import { createAuthoritySupervisor } from './supervisor'
import { createSimulatedOutputWatchdog } from './watchdog'
export const authorityScenarios = ['nominal', 'rc-override', 'rc-loss', 'link-loss', 'pi-loss', 'board-reset', 'estimator-loss', 'battery-reserve', 'fence-target', 'kill', 'disarm', 'watchdog', 'lease-loss'] as const
export type AuthorityScenario = typeof authorityScenarios[number]

/** Fault injection and operator script for the owned physics fixture only. */
export function createAuthorityHarness(scenario: AuthorityScenario) {
  if (!authorityScenarios.includes(scenario)) throw new RangeError('Unknown authority scenario')
  const supervisor = createAuthoritySupervisor({ sessionId: 123n, bootId: 55n })
  const board = createSimulatedOutputWatchdog({ sessionId: 123n, bootId: 55n })
  let faultInjected = false, firstRevocationMs: number | null = null, firstZeroMs: number | null = null, wasActive = false, lastHostCheckMs: number | null = null
  function alive(nowMs: number) { return !(scenario === 'pi-loss' && nowMs >= 3000) }
  function noteZero(nowMs: number) { if (wasActive && firstZeroMs === null && board.snapshot().motorsN.every(n => n === 0)) firstZeroMs = nowMs }
  return {
    alive,
    boardTick(nowMs: number) {
      if (!faultInjected && nowMs >= 3000) {
        if (scenario === 'board-reset') board.reboot(56n)
        if (scenario === 'watchdog') board.trip()
        faultInjected = true
      }
      const result = board.tick(nowMs)
      noteZero(nowMs)
      return result.motorsN
    },
    observe(nowMs: number, estimate: EstimatorSnapshot, truth: RigidBodyState, target: PositionTarget) {
      if (!alive(nowMs)) return supervisor.snapshot()
      lastHostCheckMs = nowMs
      const failed = nowMs >= 3000, pulse = failed && nowMs < 3100
      const runtime = board.snapshot()
      const o: AuthorityObservation = {
        kind: 'simulation', nowMs, estimate,
        runtime: { bootId: runtime.bootId, capturedAtMs: nowMs, watchdogHealthy: runtime.fault === null },
        rc: { capturedAtMs: nowMs, connected: !(failed && scenario === 'rc-loss'), armSwitch: !(failed && scenario === 'disarm'), override: pulse && scenario === 'rc-override' },
        interlocks: { capturedAtMs: nowMs, killActive: pulse && scenario === 'kill', onGround: nowMs <= 600 || truth.groundContact, motorsStopped: truth.motorsN.every(n => n < 0.01) },
        battery: { capturedAtMs: nowMs, remainingPercent: failed && scenario === 'battery-reserve' ? 20 : 90 },
        link: { capturedAtMs: nowMs, connected: !(failed && scenario === 'link-loss') },
      }
      const send = (action: AuthorityAction) => {
        const s = supervisor.snapshot()
        return supervisor.update(o, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: scenario === 'fence-target' && failed ? { positionM: [21, 0, -1], yawRad: 0 } : target })
      }
      supervisor.update(o)
      if (nowMs === 600) { send('arm'); send('engage') }
      if (nowMs % 20 === 0 && supervisor.snapshot().state === 'autonomous' && !(scenario === 'lease-loss' && failed)) send('renew')
      const s = supervisor.snapshot()
      if (s.state === 'autonomous') wasActive = true
      else {
        if (wasActive && firstRevocationMs === null) firstRevocationMs = nowMs
        board.revoke(); noteZero(nowMs)
      }
      return s
    },
    apply(output: SimulatedControlOutput, nowMs: number) {
      const frame = supervisor.gate(output, nowMs)
      if (frame) board.accept(frame, nowMs)
      else board.revoke()
      if (wasActive && supervisor.snapshot().state !== 'autonomous' && firstRevocationMs === null) firstRevocationMs = nowMs
      noteZero(nowMs)
      return board.snapshot().motorsN
    },
    snapshot(nowMs: number) {
      return { evidence: 'modeled-authority-and-output-watchdog' as const, scenario, hostAlive: alive(nowMs), lastHostCheckMs, supervisor: supervisor.snapshot(), board: board.snapshot(), firstRevocationMs, firstZeroMs, hardwareInLoop: false, physicalKillVerified: false, recoveryAction: 'zero-modeled-thrust-no-landing-or-manual-stick-controller' }
    },
  }
}
