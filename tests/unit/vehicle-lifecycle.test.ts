import { expect, test } from 'bun:test'
import { createVtolHoverProfile } from '../../resources/functions/drone/vehicles/vtol'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

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
