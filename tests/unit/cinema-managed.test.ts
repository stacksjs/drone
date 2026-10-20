import { expect, test } from 'bun:test'
import type { CinemaFaultCode, CinemaRun } from '../../resources/functions/drone/cinema/types'
import type { CinemaManagedRun } from '../../resources/functions/drone/cinema/managed-types'
import * as cinema from '../../resources/functions/drone/cinema/runtime'

// Public owned-world seam: producer loss while policy survives, not host death.
test('managed source expiry wins renewal and ACK at the real first exposure', () => {
  expect(cinema.simulateManagedCinema).toBeFunction()
  const run = cinema.simulateManagedCinema({ scenario: 'source-expiry-with-foreign' }), s = run.shot.startedAtMs!
  expect(s).not.toBeNull()
  expect(run.version).toBe(2)
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('gimbal-source-expired')
  expect(run.shot.firstFault).toEqual({ atMs: s + 1020, code: 'gimbal-source-expired' })
  expect(run.shot.retirement.atMs).toBe(s + 1020)
  expect(run.mission.terminalReason).toBe('operator-abort')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.shot.counters.shutterAttempts).toBe(1)
  expect(run.shot.counters.ackReceipts).toBe(0)
  expect(run.captures).toHaveLength(1)
  const capture = run.captures[0]!
  expect(capture.issuedAtMs).toBe(s + 1000)
  expect(capture.capturedAtMs).toBe(s + 1000)
  expect(capture.image!.rgba).toHaveLength(12288)
  expect(capture.actual).not.toBeNull()
  expect(capture.encoder.capturedAtMs).toBe(s + 980)
  expect(capture.state).toBe('uncertain')
  expect(capture.reason).toBe('gimbal-source-expired')
  expect(capture.ack).toBeNull()
  expect(run.manager.firstInhibit).toEqual({ atMs: s + 1020, code: 'gimbal-source-expired' })
  expect(run.manager.lastAccepted!.issuedAtMs).toBe(s + 940)
  expect(run.manager.lastAccepted!.expiresAtMs).toBe(s + 1020)
  expect(run.manager.captureCommands).toEqual([{ captureSequence: 1, atMs: s + 1000, command: run.manager.lastAccepted! }])
  expect(run.manager.foreignRejections).toEqual([{ atMs: s + 1000, sourceKind: 'operator', sourceId: 'foreign-operator-v1', selectedIssuedAtMs: s + 940, selectedExpiresAtMs: s + 1020, rejection: 'foreign' }])
  expect(run.manager.counters.rejectedForeignCommands).toBe(1)
  expect(run.manager.counters.rejectedSelectedCommands).toBe(0)
  expect(run.manager.counters.commandsAfterRetirement).toBe(0)
  expect(run.manager.retirement).toEqual({ atMs: s + 1020, directive: 'zero-requested-torque' })
  expect(run.manager.transitions.map(t => [t.to, t.reason])).toEqual([['active', 'selected-command'], ['inhibited', 'gimbal-source-expired'], ['retired', 'session-retired']])
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.gimbal.tail).toHaveLength(501)
  const last = run.gimbal.rows.at(-1)!, boundary = run.gimbal.tail[0]!
  expect(last.atMs).toBe(s + 1020)
  expect(boundary.positionRad).toEqual(last.positionRad)
  expect(boundary.velocityRadS).toEqual(last.velocityRadS)
  expect(boundary.accelerationRadS2).toEqual(last.accelerationRadS2)
  expect(boundary.appliedTorqueNm).toEqual(last.appliedTorqueNm)
  expect(boundary.requestedTorqueNm).toEqual([0, 0, 0])
  expect(boundary.velocityRadS.some(v => v !== 0)).toBe(true)
  expect(run.gimbal.tail.at(-1)!.atMs).toBe(s + 3020)
  expect(run.evaluation.motion.withinDynamicBounds).toBe(true)
  expect(run.evaluation.motion.withinMechanicalBounds).toBe(true)
  expect(run.reconciliation.invalidCaptureSequences).toEqual([])
  expect(Buffer.byteLength(JSON.stringify(run.manager) + '\n')).toBeLessThanOrEqual(12288)
  expect(Buffer.byteLength(JSON.stringify(run) + '\n')).toBeLessThanOrEqual(20971520)
}, 70000)

test('managed nominal lands with three admitted frames and the unchanged legacy world', () => {
  const run = cinema.simulateManagedCinema(), legacy = cinema.simulateCinema()
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('qualified')
  expect(run.mission.terminalReason).toBe('landed')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.physicalGimbalActuationEnabled).toBe(false)
  expect(run.identityAuthenticated).toBe(false)
  expect(run.manager.physicalActuationEnabled).toBe(false)
  expect(run.manager.identityAuthenticated).toBe(false)
  expect(run.manager.firstInhibit).toBeNull()
  expect(run.manager.retirement.atMs).toBe(run.shot.startedAtMs! + 8000)
  expect(run.manager.transitions.map(t => [t.to, t.reason])).toEqual([['active', 'selected-command'], ['retired', 'session-retired']])
  expect(run.manager.counters.rejectedForeignCommands).toBe(0)
  expect(run.manager.counters.rejectedSelectedCommands).toBe(0)
  expect(run.manager.foreignRejections).toEqual([])
  expect(run.captures).toHaveLength(3)
  for (const [index, capture] of run.captures.entries()) {
    expect(capture.state).toBe('confirmed')
    expect(capture.quality.qualified).toBe(true)
    expect(capture.postStepAdmission).toBe('valid')
    expect(run.manager.captureCommands[index]!.captureSequence).toBe(capture.sequence)
    expect(run.manager.captureCommands[index]!.atMs).toBe(capture.issuedAtMs)
    expect(run.manager.captureCommands[index]!.command.issuedAtMs).toBe(capture.issuedAtMs)
    expect(run.manager.captureCommands[index]!.command.expiresAtMs).toBe(capture.issuedAtMs + 80)
  }
  expect(run.manager.counters.acceptedCommands).toBe(run.shot.counters.trackingCommands + 1)
  const { manager, evaluation, ...base } = run
  const original = { ...base, version: 1, evidence: 'owned-cinema-hover-reframe-simulation', profile: 'hover-poi-reframe-v1', scenario: 'nominal', evaluation }
  expect(JSON.stringify(original)).toBe(JSON.stringify(legacy))
  expect(Object.keys(run)).toEqual([...Object.keys(legacy).slice(0, -1), 'manager', 'evaluation'])
  expect(Object.keys(manager)).toEqual(['version', 'evidence', 'physicalActuationEnabled', 'identityAuthenticated', 'policy', 'selection', 'lastAccepted', 'firstInhibit', 'retirement', 'counters', 'transitions', 'captureCommands', 'foreignRejections'])
  expect(Buffer.byteLength(JSON.stringify(manager) + '\n')).toBeLessThanOrEqual(12288)
  expect(JSON.stringify(cinema.simulateManagedCinema())).toBe(JSON.stringify(run))
}, 70000)

// Compile-only public compatibility checks in the persistent runtime TS7 project.
if (false) {
  const legacy: CinemaRun = cinema.simulateCinema()
  const managed: CinemaManagedRun = cinema.simulateManagedCinema()
  // @ts-expect-error A managed v2 result is deliberately not a legacy result.
  const incompatible: CinemaRun = cinema.simulateManagedCinema()
  // @ts-expect-error Legacy callers retain their closed vehicle/camera fault union.
  const legacyFault: CinemaFaultCode = 'gimbal-source-expired'
  void legacy; void managed; void incompatible; void legacyFault
}

test('managed input accepts only its own two-scenario envelope without private echoes', () => {
  let reads = 0
  const proxy = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('private') }, ownKeys() { reads++; throw new Error('private') } })
  for (const input of [null, [], proxy, { scenario: 'body-disturbance' }, { scenario: 'private' }, { extra: true }, { scenario: ['nominal'] }, { get scenario() { reads++; throw new Error('private') } }, Object.create({ scenario: 'nominal' })]) {
    expect(() => cinema.simulateManagedCinema(input)).toThrow(new TypeError('cinema-managed-input'))
  }
  expect(reads).toBe(0)
})
