import { expect, test } from 'bun:test'
import { simulateVision, visionScenarios } from '../../resources/functions/drone/vision/simulation'

test('selected calibrated vision follows through the owned raw-sensor controller and releases at the authored end', () => {
  const run = simulateVision()
  expect(run.status, JSON.stringify({ reason: run.reason, fusion: run.fusion, metrics: run.metrics, last: run.path.at(-1), firstBlocked: run.path.find(row => row.state === 'blocked') })).toBe('completed')
  expect(run.evidence).toBe('owned-vision-physics-simulation')
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.boardOutputsInhibited).toBe(true)
  expect(run.calibration.physicalCalibrationVerified).toBe(false)
  expect(run.metrics.followTravelM).toBeGreaterThan(4)
  expect(run.metrics.maxTargetErrorM).toBeLessThan(0.15)
  expect(run.metrics.maxThreeSigmaRatio).toBeLessThan(1)
  expect(run.metrics.maxVisualErrorM).toBeLessThan(0.15)
  expect(run.metrics.maxVisualThreeSigmaRatio).toBeLessThan(1)
  expect(run.metrics.minSeparationM).toBeGreaterThanOrEqual(2)
  expect(run.path.some(row => row.state === 'following' && row.fusedM !== null && !row.outputNeutral)).toBe(true)
  expect(run.path.filter(row => row.nowMs < 3240).every(row => row.fusedM === null)).toBe(true)
  expect(new Set(run.path.map(row => row.selectedLockId).filter(Boolean)).size).toBe(1)
  expect(run.path.at(-1)!.state).toBe('released')
  expect(run.path.at(-1)!.fusedM).not.toBeNull()
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  expect(run.authority.state).toBe('disarmed')
  expect(run.path.length).toBeLessThanOrEqual(301)
}, 60000)

test('crossings, occlusion, missing depth or target, identity disagreement, pose reset and RC takeover latch neutral outputs', () => {
  for (const scenario of visionScenarios.filter(s => s !== 'follow' && s !== 'camera-loss')) {
    const run = simulateVision({ scenario })
    expect(run.status, scenario).toBe('blocked')
    expect(run.fusion.state, scenario).toBe('lost')
    expect(run.fusion.target, scenario).toBeNull()
    expect(run.path.some(row => row.state === 'following' && !row.outputNeutral), scenario).toBe(true)
    const firstBlocked = run.path.find(row => row.state === 'blocked')!
    expect(firstBlocked.nowMs, scenario).toBeGreaterThanOrEqual(10000)
    expect(firstBlocked.nowMs, scenario).toBeLessThanOrEqual(10300)
    expect(run.path.filter(row => row.nowMs >= firstBlocked.nowMs).every(row => row.outputNeutral && row.fusedM === null && row.state === 'blocked'), scenario).toBe(true)
    expect(run.path.at(-1)!.nowMs, scenario).toBe(20000)
    expect(run.metrics.minSeparationM, scenario).toBeGreaterThanOrEqual(2)
    expect(run.board.motorsN, scenario).toEqual([0, 0, 0, 0])
    expect(run.authority.state, scenario).not.toBe('autonomous')
    expect(new Set(run.path.map(row => row.selectedLockId).filter(Boolean)).size, scenario).toBe(1)
  }
}, 60000)

test('a restored camera stream cannot resume motors or replace an explicitly lost target', () => {
  const run = simulateVision({ scenario: 'camera-loss' })
  expect(run.status).toBe('blocked')
  expect(run.fusion.state).toBe('lost')
  expect(run.fusion.target).toBeNull()
  const before = run.path.find(row => row.nowMs === 9900)!
  const after = run.path.find(row => row.nowMs === 15000)!
  const firstBlocked = run.path.find(row => row.state === 'blocked')!
  expect(after.frameSequence).toBeGreaterThan(firstBlocked.frameSequence!)
  expect(after.selectedLockId).toBe(before.selectedLockId)
  expect(firstBlocked.nowMs).toBeGreaterThanOrEqual(10000)
  expect(firstBlocked.nowMs).toBeLessThanOrEqual(10300)
  expect(run.path.filter(row => row.nowMs >= firstBlocked.nowMs).every(row => row.outputNeutral && row.fusedM === null && row.state === 'blocked')).toBe(true)
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  expect(run.authority.state).not.toBe('autonomous')
}, 60000)

test('ending before the delayed fault arrives cannot report a completed hazard demonstration', () => {
  const run = simulateVision({ scenario: 'depth-loss', seconds: 10 })
  expect(run.status).toBe('blocked')
  expect(run.reason).toBe('authored-fault-not-observed')
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
}, 60000)
