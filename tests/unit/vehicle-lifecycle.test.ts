import { expect, test } from 'bun:test'
import { createVtolHoverProfile } from '../../resources/functions/drone/vehicles/vtol'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import type { VehiclePlantState } from '../../resources/functions/drone/vehicles/types'

// Agreed shared-runtime seam: actual sensor/estimator/mission/controller/independent lease
// execution. This verifies operator lifecycle delivery, not physical pause or recovery.
test('scheduled operator pause and resume reach the real hover loop and its replay without withdrawing authority', () => {
  const report = runVehicleSimulation(createVtolHoverProfile(), { seconds: 60, missionActions: [
    { atMs: 4000, action: 'pause' },
    { atMs: 6000, action: 'resume' },
  ] })
  const paused = report.path.filter(row => row.mission.state === 'paused')
  expect(paused).toHaveLength(100)
  expect(paused[0]!.atMs).toBe(4000)
  expect(paused.at(-1)!.atMs).toBe(5980)
  expect(paused.every(row => row.mission.reason === 'operator-pause' && row.mission.targetM?.every((n, i) => n === paused[0]!.mission.targetM![i]))).toBe(true)
  expect(paused.every(row => row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
  expect(report.trace.rows.filter(row => row.action === 'pause' || row.action === 'resume').map(row => [row.observation.nowMs, row.action])).toEqual([[4000, 'pause'], [6000, 'resume']])
  expect(report.status).toBe('completed')
  expect(report.mission.reason).toBe('landed')
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.physicalFlightEnabled).toBe(false)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('invalid operator schedules are refused before creating a session or invoking data accessors', () => {
  let accessorCalls = 0
  const getterEvent = Object.defineProperty({ action: 'pause' }, 'atMs', { enumerable: true, get() { accessorCalls++; return 1000 } })
  const cases: [string, unknown][] = [
    ['off-grid', [{ atMs: 1001, action: 'pause' }]],
    ['null', null],
    ['not-an-array', {}],
    ['sparse', new Array(1)],
    ['too-many', Array.from({ length: 33 }, () => ({ atMs: 1000, action: 'pause' }))],
    ['automatic-start-collision', [{ atMs: 600, action: 'pause' }]],
    ['before-start', [{ atMs: 580, action: 'pause' }]],
    ['past-duration', [{ atMs: 2020, action: 'pause' }]],
    ['non-finite', [{ atMs: NaN, action: 'pause' }]],
    ['unsafe-integer', [{ atMs: Number.MAX_SAFE_INTEGER + 1, action: 'pause' }]],
    ['duplicate', [{ atMs: 1000, action: 'pause' }, { atMs: 1000, action: 'resume' }]],
    ['reversed', [{ atMs: 1020, action: 'pause' }, { atMs: 1000, action: 'resume' }]],
    ['second-start', [{ atMs: 1000, action: 'start' }]],
    ['unknown-action', [{ atMs: 1000, action: 'fly' }]],
    ['extra-field', [{ atMs: 1000, action: 'pause', retry: true }]],
    ['accessor', [getterEvent]],
  ]
  const violations: { label: string, created: number, message: string }[] = []
  for (const [label, missionActions] of cases) {
    const profile = createVtolHoverProfile(), createSession = profile.createSession
    let created = 0, message = ''
    profile.createSession = () => { created++; return createSession() }
    try { runVehicleSimulation(profile, { seconds: 2, missionActions: missionActions as never }) }
    catch (error) { message = error instanceof Error ? error.message : String(error) }
    if (created !== 0 || message !== 'Invalid vehicle mission action schedule') violations.push({ label, created, message })
  }
  expect(violations).toEqual([])
  expect(accessorCalls).toBe(0)
})


test('validated lifecycle events are independent of caller mutation during session creation', () => {
  const first = { atMs: 4000, action: 'pause' as const }, second = { atMs: 6000, action: 'resume' as const }
  const missionActions = [first, second], profile = createVtolHoverProfile(), createSession = profile.createSession
  profile.createSession = () => {
    first.atMs = 2000; second.atMs = 2020; missionActions.reverse()
    return createSession()
  }
  const report = runVehicleSimulation(profile, { seconds: 60, missionActions })
  expect(report.trace.rows.filter(row => row.action === 'pause' || row.action === 'resume').map(row => [row.observation.nowMs, row.action])).toEqual([[4000, 'pause'], [6000, 'resume']])
  expect(report.status).toBe('completed')
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('an empty lifecycle schedule preserves every legacy hover recording and report field', () => {
  const legacy = runVehicleSimulation(createVtolHoverProfile(), { seconds: 60 })
  const empty = runVehicleSimulation(createVtolHoverProfile(), { seconds: 60, missionActions: [] })
  expect(empty).toEqual(legacy)
  expect(Object.keys(empty)).toEqual(Object.keys(legacy))
  expect(empty.trace.rows.every(row => row.action === null || row.action === 'start')).toBe(true)
})


for (const bankedEntry of [false, true]) test(`a paused wing-borne VTOL flies a bounded clockwise 60 m loiter from ${bankedEntry ? 'banked' : 'straight'} entry before resuming and landing`, () => {
  const profile = createVtolTransitionProfile(), createSession = profile.createSession
  const destination = bankedEntry ? [150, 100] : [180, 0]
  if (bankedEntry) for (const task of profile.mission.tasks) {
    if ((task.id === 'cruise-leg' || task.id === 'land') && 'positionM' in task) { task.positionM[0] = destination[0]!; task.positionM[1] = destination[1]! }
    if (task.id === 'back' && task.kind === 'vtol-mode') task.headingRad = 1
  }
  const observed: { atMs: number, state: VehiclePlantState }[] = []
  profile.createSession = () => {
    const session = createSession()
    return { ...session, observeIndependent(state, atMs) {
      if (atMs % 20 === 0 && atMs >= 20000 && atMs < 40000) observed.push({ atMs, state: structuredClone(state) })
    } }
  }
  const report = runVehicleSimulation(profile, { seconds: 160, missionActions: [{ atMs: 20000, action: 'pause' }, { atMs: 40000, action: 'resume' }] })
  const entry = report.trace.rows.find(row => row.observation.nowMs === 20000)!.observation
  const course = Math.atan2(entry.velocityMps[1], entry.velocityMps[0])
  const center = [entry.positionM[0] - 60 * Math.sin(course), entry.positionM[1] + 60 * Math.cos(course)]
  const settled = observed.filter(row => row.atMs >= 26000)
  const radialError = Math.max(...settled.map(row => Math.abs(Math.hypot(row.state.positionM[0] - center[0]!, row.state.positionM[1] - center[1]!) - 60)))
  const paused = report.path.filter(row => row.mission.state === 'paused')
  console.log('VTOL_PAUSE_LOITER', JSON.stringify({ bankedEntry, status: report.status, fault: report.fault, pausedRows: paused.length, settledRows: settled.length, maximumRadialErrorM: radialError }))
  expect(paused).toHaveLength(1000)
  expect(settled.length).toBeGreaterThan(600)
  expect(radialError).toBeLessThan(8)
  expect(settled.every(row => Math.abs(row.state.positionM[2] + 15) < 2)).toBe(true)
  expect(settled.every(row => (row.state.details.airspeedMps as number) >= 12 && (row.state.details.airspeedMps as number) <= 14)).toBe(true)
  expect(settled.every(row => (row.state.details.rotorThrustN as number) < 1)).toBe(true)
  expect(report.status).toBe('completed')
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(Math.hypot(report.finalTruthPositionM[0] - destination[0]!, report.finalTruthPositionM[1] - destination[1]!)).toBeLessThan(0.3)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('a qualified post-back landing contact can pause with neutral outputs and explicitly resume', () => {
  const baseline = runVehicleSimulation(createVtolTransitionProfile(), { seconds: 160 })
  expect(baseline.status).toBe('completed')
  const contact = baseline.path.find(row => row.mission.state === 'running' && row.mission.taskKind === 'land' && row.measurement?.values.onSurface === true)
  expect(contact).toBeDefined()
  const pauseAtMs = contact!.atMs
  const report = runVehicleSimulation(createVtolTransitionProfile(), { seconds: 160, missionActions: [{ atMs: pauseAtMs, action: 'pause' }, { atMs: pauseAtMs + 2000, action: 'resume' }] })
  const paused = report.path.filter(row => row.mission.state === 'paused')
  console.log('VTOL_CONTACT_PAUSE', JSON.stringify({ pauseAtMs, status: report.status, fault: report.fault, pausedRows: paused.length }))
  expect(paused).toHaveLength(100)
  expect(paused.every(row => row.measurement!.values.onSurface === true && row.truthPositionM[2] === 0 && row.actuators.every(n => n === 0))).toBe(true)
  expect(report.status).toBe('completed')
  expect(report.fault).toBeNull()
  expect(report.mission.reason).toBe('landed')
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})
