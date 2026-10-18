import type { InspectionConfig, InspectionPlan } from './types'
import type { SensorVector } from '../sensors/types'
import type { MissionPlan, MissionTask } from '../missions/plan'
import { createCalibratedCamera } from '../camera/calibrated'
import { geodeticToEcef } from '../estimation/frames'
import { validateMission } from '../missions/plan'
import { inspectionAssetPoint, inspectionSegmentSeparation } from './geometry'

function fail(reason: string): never { throw new RangeError(`Invalid inspection: ${reason}`) }
function record(v: unknown, keys: string[], name: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || keys.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !keys.includes(k))) fail(`${name} fields`)
}
function bounded(v: unknown, min: number, max: number, name: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(name)
}
function id(v: unknown): void { if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(v)) fail('identifier') }

/** Compile one explicitly registered bridge face into the owned bounded mission graph. */
export function createInspectionPlan(input: unknown): InspectionPlan {
  record(input, ['version', 'id', 'asset', 'stations', 'standOffM', 'speedMps', 'clearance', 'quality', 'exposureTimeUs', 'power', 'calibration', 'heldOut'], 'config')
  const c = input as unknown as InspectionConfig
  if (c.version !== 1) fail('version'); id(c.id)
  const a = c.asset
  record(a, ['version', 'id', 'revision', 'kind', 'frame', 'axes', 'origin', 'centerM', 'widthM', 'heightM', 'registrationSigmaM'], 'asset')
  if (a.version !== 1 || a.kind !== 'bridge-face' || a.frame !== 'LOCAL_NED' || a.axes !== 'EAST_UP_SOUTH') fail('asset semantics')
  id(a.id); id(a.revision)
  record(a.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'], 'origin'); geodeticToEcef(a.origin)
  bounded(a.origin.ellipsoidHeightM, -500, 10000, 'origin height')
  if (!Array.isArray(a.centerM) || a.centerM.length !== 3) fail('asset center')
  for (const n of a.centerM) bounded(n, -8, 8, 'asset center')
  bounded(a.widthM, .2, 6, 'asset width'); bounded(a.heightM, .2, 5, 'asset height'); bounded(a.registrationSigmaM, .001, .1, 'registration uncertainty')
  if (a.centerM[2] + a.heightM / 2 > 0 || a.centerM[2] - a.heightM / 2 < -4.5) fail('asset vertical extent')
  bounded(c.standOffM, .8, 5, 'stand-off'); bounded(c.speedMps, .05, .6, 'speed')
  record(c.clearance, ['minSeparationM', 'bodyRadiusM', 'positionBoundM', 'assetMotionBoundM', 'brakingAccelerationMps2', 'reactionMs'], 'clearance')
  const cl = c.clearance
  bounded(cl.minSeparationM, .2, 2, 'minimum separation'); bounded(cl.bodyRadiusM, .22, 1, 'body radius'); bounded(cl.positionBoundM, .05, .5, 'position bound'); bounded(cl.assetMotionBoundM, .05, .5, 'asset motion bound'); bounded(cl.brakingAccelerationMps2, .1, 2, 'braking acceleration'); bounded(cl.reactionMs, 80, 500, 'reaction time')
  record(c.quality, ['maxGsdM', 'maxBlurPx', 'minAssetFraction', 'maxPoseSigmaM', 'maxAttitudeSigmaRad', 'maxStationOffsetM'], 'quality')
  const q = c.quality
  bounded(q.maxGsdM, .001, .1, 'GSD'); bounded(q.maxBlurPx, .1, 2, 'blur'); bounded(q.minAssetFraction, .05, .95, 'asset fraction'); bounded(q.maxPoseSigmaM, .01, cl.positionBoundM, 'pose sigma'); bounded(q.maxAttitudeSigmaRad, .001, .2, 'attitude sigma'); bounded(q.maxStationOffsetM, .05, .5, 'station offset')
  bounded(c.exposureTimeUs, 10, 10000, 'exposure'); if (!Number.isInteger(c.exposureTimeUs)) fail('exposure integer')
  record(c.power, ['availableWh', 'hoverW', 'reservePercent'], 'power')
  bounded(c.power.availableWh, .1, 1000, 'available power'); bounded(c.power.hoverW, 100, 2000, 'hover power'); bounded(c.power.reservePercent, 26, 80, 'power reserve')
  const camera = createCalibratedCamera(c.calibration, c.heldOut), calibration = camera.calibration
  const quaternion = calibration.extrinsics.quaternionWxyz
  const desired = [.5, .5, .5, .5]
  if (Math.min(Math.hypot(...quaternion.map((n, i) => n - desired[i]!)), Math.hypot(...quaternion.map((n, i) => n + desired[i]!))) > 1e-6 || Math.hypot(...camera.originBodyM) > cl.bodyRadiusM) fail('fixed forward camera and contained lever required')
  if (calibration.output.width * calibration.output.height > 65536) fail('image pixel budget')
  const depth = c.standOffM - camera.originBodyM[0]
  if (depth < camera.report.minDepthM || depth > camera.report.maxDepthM) fail('stand-off outside calibrated depth coverage')
  if (!Array.isArray(c.stations) || c.stations.length < 1 || c.stations.length > 3) fail('station budget')
  const ids = new Set<string>()
  const stations = c.stations.map(s => {
    record(s, ['id', 'uM', 'vM'], 'station'); id(s.id)
    if (ids.has(s.id)) fail('duplicate station'); ids.add(s.id)
    bounded(s.uM, -a.widthM / 2, a.widthM / 2, 'station U'); bounded(s.vM, -a.heightM / 2, a.heightM / 2, 'station V')
    const assetPointM = inspectionAssetPoint(a, s.uM, s.vM)
    return { ...s, assetPointM, vehiclePositionM: [assetPointM[0] - c.standOffM, assetPointM[1], assetPointM[2]] as SensorVector }
  })
  const rallyM: SensorVector = [0, 0, stations[0]!.vehiclePositionM[2]]
  const tasks: MissionTask[] = [{ id: 'takeoff', kind: 'takeoff', positionM: rallyM, timeoutMs: 15000, next: `station-${stations[0]!.id}` }]
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i]!
    tasks.push({ id: `station-${s.id}`, kind: 'waypoint', positionM: s.vehiclePositionM, timeoutMs: 12000, next: `capture-${s.id}` })
    tasks.push({ id: `capture-${s.id}`, kind: 'loiter', positionM: s.vehiclePositionM, durationMs: 1000, timeoutMs: 5000, next: i + 1 < stations.length ? `station-${stations[i + 1]!.id}` : 'return' })
  }
  tasks.push({ id: 'return', kind: 'return', timeoutMs: 15000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 15000 })
  const mission: MissionPlan = { version: 1, id: c.id, frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { ...a.origin }, fence: { radiusM: 12, minDownM: -4.5 }, rallyM, power: { ...c.power }, start: 'takeoff', speedMps: c.speedMps, tasks }
  const validated = validateMission(mission)
  const inflatedClearanceM = cl.minSeparationM + cl.bodyRadiusM + cl.positionBoundM + cl.assetMotionBoundM + c.speedMps * cl.reactionMs / 1000 + c.speedMps ** 2 / (2 * cl.brakingAccelerationMps2)
  let previous: SensorVector = [0, 0, 0], minimumPlannedSeparationM = Infinity
  for (const task of tasks) {
    const next = task.kind === 'return' ? rallyM : 'positionM' in task ? task.positionM : previous
    minimumPlannedSeparationM = Math.min(minimumPlannedSeparationM, inspectionSegmentSeparation(a, previous, next))
    // The south-side policy excludes behind-face approaches, including launch and landing.
    if (previous[0] >= a.centerM[0] || next[0] >= a.centerM[0]) fail('route leaves outward face half-space')
    previous = next
  }
  if (minimumPlannedSeparationM < inflatedClearanceM) fail('route clearance including launch, return and landing')
  return { version: 1, config: structuredClone(c), stations, inflatedClearanceM, minimumPlannedSeparationM, mission: validated.plan, assumptions: ['Synthetic or operator-declared registration, never authenticated physical asset geometry.', 'Fixed south-facing rectangular bridge face, east/up face axes and fixed WGS84 LOCAL_NED origin.', 'Clearance applies to every straight planned segment with body radius, declared position/motion envelopes, reaction and braking.', 'Camera uses held-out calibration; physical camera, thermal radiometry and field inspection accuracy remain unverified.', 'Power reserve uses bounded mission timeout budget; abort inhibits modeled outputs without a controlled emergency landing.'] }
}
