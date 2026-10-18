import { expect, test } from 'bun:test'
import { planNavigationPath, navigationEnvelope } from '../../resources/functions/drone/navigation/planner'
import type { NavigationMap } from '../../resources/functions/drone/navigation/perception'
const map: NavigationMap = { version: 1, evidence: 'modeled-range', sequence: 1, reference: '55:0,0,0,0,0', capturedAtMs: 1000, receivedAtMs: 1060, latencyMs: 60, clockUncertaintyMs: 1, uncertaintyM: 0.045, coverage: { centerM: [0, 0, -1.2], radiusM: 8 }, obstacles: [{ id: 'post', northM: 2.5, eastM: 0, radiusM: 0.25 }], terrain: { northSlope: -0.03, eastSlope: 0, downAtOriginM: 0 }, landing: { id: 'pad', positionM: [0.1, 0.06, -0.003] } }
test('routes around measured obstacles with braking and uncertainty clearance', () => {
  const marginM = navigationEnvelope({ speedMps: 0.6, ageMs: 100, uncertaintyM: 0.045 }).clearanceM
  const result = planNavigationPath({ map, startM: [0, 0, -1.2], goalM: [5, 0, -1.2], fenceRadiusM: 12, minDownM: -5, marginM })
  expect(result).not.toBeNull()
  expect(result!.length).toBeGreaterThan(2)
  expect(result!.at(-1)).toEqual([5, 0, -1.2])
  expect(Math.max(...result!.map(p => Math.abs(p[1])))).toBeGreaterThan(1)
})

import { detectNavigationMap, terrainDownAt } from '../../resources/functions/drone/navigation/perception'
import type { RangePacket } from '../../resources/functions/drone/navigation/perception'
import { createNavigator, navigationGoal } from '../../resources/functions/drone/navigation/navigator'
import type { MissionObservation } from '../../resources/functions/drone/missions/engine'
import { simulateNavigation } from '../../resources/functions/drone/navigation/simulation'
function observation(nowMs: number): MissionObservation { return { kind: 'simulation', nowMs, reference: map.reference, origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM: [0, 0, -1.2], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 90, onGround: false } }
function raw(): RangePacket { return { version: 1, evidence: 'modeled-range', frame: 'BODY_FRD', sequence: 1, reference: map.reference, capturedAtMs: 1000, receivedAtMs: 1060, clockUncertaintyMs: 1, rangeSigmaM: 0.01, coverage: 'complete-360-model', maxRangeM: 8, clusters: [{ id: 'post', pointsBodyM: [[1.75, 0, 0], [2, 0.25, 0], [2.25, 0, 0]] }], groundBodyM: [[0, 0, 1.2], [1, 0, 1.17], [0, 1, 1.2]], landing: { id: 'pad', pointBodyM: [0.1, 0.06, 1.197] } } }
test('range detection reconstructs a calibrated cylinder, sloped terrain and selected pad from body measurements', () => {
  const pose = { reference: map.reference, atMs: 1000, positionM: [0, 0, -1.2] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number], positionSigmaM: 0.02 }
  const detected = detectNavigationMap(raw(), pose)
  expect(detected.latencyMs).toBe(60)
  expect(detected.obstacles).toEqual([{ id: 'post', northM: 2, eastM: 0, radiusM: 0.25 }])
  expect(terrainDownAt(detected, [5, 0, 0])).toBeCloseTo(-0.15, 8)
  expect(detected.landing!.positionM[2]).toBeCloseTo(-0.003, 8)
  expect(detected.uncertaintyM).toBeCloseTo(0.09, 8)
  expect(() => detectNavigationMap({ ...raw(), receivedAtMs: 1240 }, pose)).toThrow('Unqualified')
  expect(() => detectNavigationMap(raw(), { ...pose, atMs: 980 })).toThrow()
  const degenerate = raw(); degenerate.clusters[0]!.pointsBodyM = [[1, 0, 0], [2, 0, 0], [3, 0, 0]]
  expect(() => detectNavigationMap(degenerate, pose)).toThrow()
})

test('braking includes sensing age, controller delay, body radius and explicit uncertainty', () => {
  const envelope = navigationEnvelope({ speedMps: 1, ageMs: 100, uncertaintyM: 0.05 })
  expect(envelope.reactionM).toBeCloseTo(0.35, 8)
  expect(envelope.brakingM).toBe(1)
  expect(envelope.clearanceM).toBeCloseTo(1.9, 8)
  const fenced = planNavigationPath({ map, startM: [0, 0, -1.2], goalM: [5, 0, -1.2], fenceRadiusM: 5, minDownM: -5, marginM: 1.2 })
  expect(fenced).toBeNull()
  expect(() => planNavigationPath({ map: { ...map, coverage: { ...map.coverage, radiusM: NaN } }, startM: [0, 0, -1], goalM: [1, 0, -1], fenceRadiusM: 12, minDownM: -5, marginM: 1 })).toThrow()
})

test('metric follow and orbit keep explicit identity and landing refuses unselected or inconsistent sites', () => {
  const o = observation(1100)
  const target = { id: 'selected', reference: map.reference, positionM: [4, 2, -1] as [number, number, number], capturedAtMs: 1000 }
  expect(navigationGoal({ mode: 'follow', targetId: 'selected', offsetM: [-2, 0, 0], clearanceM: 1.2 }, o, map, target)).toEqual([2, 2, -1.26])
  const orbit = navigationGoal({ mode: 'orbit', targetId: 'selected', radiusM: 2, radiansPerSecond: 0.2, phaseRad: Math.PI / 2, startedAtMs: 1100, clearanceM: 1.2 }, o, map, target)
  expect(orbit[0]).toBeCloseTo(4, 8); expect(orbit[1]).toBeCloseTo(4, 8)
  expect(() => navigationGoal({ mode: 'follow', targetId: 'different', offsetM: [-2, 0, 0], clearanceM: 1.2 }, o, map, target)).toThrow('lost')
  expect(() => navigationGoal({ mode: 'land', siteId: 'unselected', expectedM: [0, 0, 0] }, o, map)).toThrow('site')
  expect(() => navigationGoal({ mode: 'land', siteId: 'pad', expectedM: [2, 0, 0] }, o, map)).toThrow('site')
})

test('navigation faults latch on range loss, replay, authority takeover, origin changes and clock gaps', () => {
  const intent = { mode: 'route' as const, goalM: [5, 0, -1.2] as [number, number, number], clearanceM: 1.2 }
  for (const mutation of ['missing', 'replay', 'origin', 'clock', 'authority', 'stale'] as const) {
    const navigator = createNavigator({ fenceRadiusM: 12, minDownM: -5 })
    expect(navigator.step(observation(1060), map, intent).state).toBe('navigating')
    let o = observation(1080)
    let range: NavigationMap | null = structuredClone(map)
    if (mutation === 'missing') range = null
    if (mutation === 'replay') range!.landing!.positionM[0] += 0.01
    if (mutation === 'origin') o.origin.latitudeDeg = 1
    if (mutation === 'clock') o.nowMs = 1120
    if (mutation === 'authority') o.authority = 'manual'
    if (mutation === 'stale') { o = observation(1200); range!.receivedAtMs = 1201 }
    const blocked = navigator.step(o, range, intent)
    expect(blocked.state).toBe('blocked'); expect(blocked.targetM).toBeNull()
    expect(navigator.step(observation(1100), map, intent).targetM).toBeNull()
  }
})

test('owned physics avoids sensed obstacles, replans, returns and precisely lands on the selected range site', () => {
  for (const scenario of ['avoid-land', 'replan'] as const) {
    const run = simulateNavigation({ scenario })
    expect(run.mission.state).toBe('completed')
    expect(run.navigation!.state).toBe('released')
    expect(run.navigation!.targetM).toBeNull()
    expect(run.metrics.minTruthClearanceM).toBeGreaterThan(1)
    expect(run.metrics.precisionLandingErrorM).toBeLessThan(0.03)
    expect(run.metrics.maxLatencyMs).toBe(60)
    expect(run.metrics.detectionFault).toBe(false)
    expect(run.navTrace.some(row => row.navigation.route.length > 1)).toBe(true)
    expect(run.navTrace.some(row => row.navigation.mode === 'rtl')).toBe(true)
    const maximumEast = Math.max(...run.navTrace.map(row => row.truthPositionM[1]!))
    if (scenario === 'avoid-land') expect(maximumEast).toBeGreaterThan(2)
    else expect(maximumEast).toBeLessThan(0.5)
    expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  }
})

test('range/position/landing loss, delayed range and RC takeover release modeled outputs', () => {
  for (const scenario of ['range-loss', 'range-delay', 'position-loss', 'landing-loss', 'rc-override'] as const) {
    const run = simulateNavigation({ scenario })
    expect(run.mission.state).toBe('blocked')
    expect(run.navigation!.targetM).toBeNull()
    expect(run.board.motorsN).toEqual([0, 0, 0, 0])
    expect(run.metrics.minTruthClearanceM).toBeGreaterThan(0.5)
    expect(run.authority.state).not.toBe('autonomous')
  }
})

import { command as cliCommand } from '@stacksjs/testing'
test('native Stacks navigation command runs the owned pipeline and rejects invalid inputs', async () => {
  const nominal = await cliCommand(['navigation:simulate', '--scenario', 'avoid-land']).withTimeout(60000)
  expect(nominal.exitCode).toBe(0)
  const result = JSON.parse(nominal.stdout)
  expect(result.mission.state).toBe('completed')
  expect(result.physicalFlightEnabled).toBe(false)
  expect(result.metrics.precisionLandingErrorM).toBeLessThan(0.03)
  expect((await cliCommand(['navigation:simulate', '--seconds', 'nan']).withTimeout(60000)).exitCode).toBe(1)
  expect((await cliCommand(['navigation:simulate', '--scenario', 'physical']).withTimeout(60000)).exitCode).toBe(1)
}, 180000)
