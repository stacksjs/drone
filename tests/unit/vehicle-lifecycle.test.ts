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
