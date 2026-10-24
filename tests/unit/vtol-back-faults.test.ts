import { expect, test } from 'bun:test'
import { createVtolBackCaptureProfile } from '../../resources/functions/drone/vehicles/vtol/back-capture-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission, parseVehicleMissionTrace } from '../../resources/functions/drone/missions/vehicle'

// Actual host, sensor and operator faults start after public approach/braking events.
// Neutral modeled outputs do not establish an airborne emergency landing.
for (const phase of ['approach', 'braking'] as const) {
  for (const failure of ['dropImu', 'dropPosition', 'dropVehicleSensor', 'rcOverride', 'kill', 'hostLost'] as const) {
    test(`planned ${phase} withdraws authority for ${failure} without retrying capture`, () => {
      const profile = createVtolBackCaptureProfile(), factory = profile.createSession
      const trigger: { atMs: number | null } = { atMs: null }
      profile.createSession = () => {
        const session = factory(), controller = session.createController()
        return { ...session, createController: () => ({ step(context) {
          const output = controller.step(context)
          const observed = phase === 'approach' ? output.reason === 'planned-wing-approach' : output.reason === 'force-managed-back-transition'
          if (observed && !output.inhibited) trigger.atMs ??= context.nowMs + 4
          return output
        } }) }
      }
      profile.faults = (_scenario, atMs) => trigger.atMs !== null && atMs >= trigger.atMs ? { [failure]: true } : {}
      const result = runVehicleSimulation(profile, { seconds: 160 })
      expect(trigger.atMs).not.toBeNull()
      expect(result.status).toBe(failure === 'hostLost' ? 'host-lost' : 'blocked')
      expect(result.path.at(-1)!.atMs).toBeLessThan(trigger.atMs! + 500)
      expect(result.mission.state).not.toBe('completed')
      expect(result.finalTruthPositionM[2]).toBeLessThan(0)
      expect(result.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
      expect(new Set(result.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
      expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
      expect(result.board.expiresAtMs).toBeNull()
      expect(result.physicalFlightEnabled).toBe(false)
      if (failure === 'hostLost') expect(result.board.fault).toBe('output-lease-expired')
      else expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
      if (failure === 'dropImu') {
        expect(result.trace.version).toBe(3)
        expect(parseVehicleMissionTrace(JSON.stringify(result.trace)).version).toBe(3)
        expect(() => replayVehicleMission({ ...result.trace, version: 2 })).toThrow('version 3')
      }
      if (failure === 'rcOverride') expect(result.authority.events.some(event => event.to === 'manual')).toBe(true)
      if (failure === 'kill') expect(result.authority.events.some(event => event.to === 'killed')).toBe(true)
    }, 60000)
  }
}

test.each([{ site: 330, outcome: 'blocked', fault: 'task-timeout' }, { site: 280, outcome: 'completed', fault: null }])('a planner abort retains the declared $site m recovery site and its $outcome outcome', ({ site, outcome, fault }) => {
  const profile = createVtolBackCaptureProfile(), factory = profile.createSession
  const back = profile.mission.tasks.find(task => task.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new TypeError('Expected back task')
  back.onFailure = 'recover-hover'
  profile.mission.tasks.push(
    { id: 'recover-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 20000, next: 'recover-land' },
    { id: 'recover-land', kind: 'land', positionM: [site, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 30000 },
  )
  const trigger: { sequence: number | null, injected: boolean } = { sequence: null, injected: false }
  profile.createSession = () => {
    const session = factory(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      const input = structuredClone(context)
      if (trigger.sequence !== null && input.mission.taskId === 'back' && input.measurement!.sequence > trigger.sequence) {
        input.measurementPose!.covarianceBlocks![0]!.velocityM2S2 = 0.09
        trigger.injected = true
      }
      const output = controller.step(input)
      if (output.reason === 'force-managed-back-transition' && input.measurement!.values.airspeedMps as number < 3) trigger.sequence ??= input.measurement!.sequence
      return output
    } }) }
  }
  const result = runVehicleSimulation(profile, { seconds: 160 })
  console.log(JSON.stringify({ oracle: 'planned-capture-declared-recovery', status: result.status, fault: result.fault, task: result.mission.taskId, reason: result.mission.reason, recovery: result.mission.recovery, confirmations: result.trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [{ task: row.observation.transition.taskId, atMs: row.observation.transition.capturedAtMs }] : []) }))
  expect(trigger.injected).toBe(true)
  expect(result.status).toBe(outcome)
  expect(result.fault).toBe(fault)
  expect(result.mission.taskId).toBe('recover-land')
  const failed = result.trace.rows.find(row => row.result.transition?.taskId === 'back')!.result.transition!
  const replacement = result.trace.rows.find(row => row.result.transition?.taskId === 'recover-hover')!.result.transition!
  expect(replacement.supersedesEventId).toBe(failed.eventId)
  expect(new Set(result.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
  expect(result.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed').map(row => row.observation.transition!.taskId)).toEqual(['initial-hover', 'front', 'recover-hover'])
  expect(result.path.flatMap(row => row.backCapture ? [row.backCapture.reason] : [])).toEqual(['declared-forecast-scenarios-complete', 'forecast-uncertainty-expanded'])
  expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(result.board.expiresAtMs).toBeNull()
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
}, 60000)
