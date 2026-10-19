import type { ApplicationConfig, ApplicationPlan } from './types'
import type { VolumeXY } from '../volumes/types'
import type { VehicleMissionPlan, VehicleMissionTask } from '../vehicles/types'
import { volumeBounds, volumeIntersectConvex, volumeOnSegment, volumeSegmentsTouch, volumeSignedArea, volumeTriangulateRing } from '../volumes/geometry'
import { validateVehicleMission } from '../missions/vehicle'
import { applicationPulseFactor, applicationRatePerSecond, applicationScaleFactor } from './calibration'

function fail(reason: string): never { throw new TypeError(`Invalid application configuration: ${reason}`) }
function number(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(name)
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertyNames(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('record fields')
}
function id(value: unknown) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) fail('identifier') }
/** Reject accessors/cycles/prototypes and bound configuration work before cloning any input. */
function bounded(input: unknown) {
  let nodes = 0, bytes = 0
  const ancestors = new Set<object>()
  function walk(value: unknown, depth: number): void {
    if (++nodes > 6000 || depth > 12) fail('config structure bound')
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('finite config quantity'); bytes += 24 }
    else if (typeof value === 'string') { if (value.length > 2048) fail('text bound'); bytes += value.length * 3 + 2 }
    else if (value === null || typeof value === 'boolean') bytes += 5
    else if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
      if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail('cyclic or symbolic config')
      if (Array.isArray(value) && value.length > 64) fail('array resource bound')
      ancestors.add(value)
      const names = Object.getOwnPropertyNames(value)
      if (names.length > 65) fail('record resource bound')
      let count = 0
      for (const name of names) {
        if (Array.isArray(value) && name === 'length') continue
        if (Array.isArray(value) && name !== String(count++)) fail('sparse or extended array')
        const descriptor = Object.getOwnPropertyDescriptor(value, name)!
        if (!('value' in descriptor) || !descriptor.enumerable) fail('accessor or hidden config')
        bytes += name.length * 3 + 4; walk(descriptor.value, depth + 1)
      }
      if (Array.isArray(value) && count !== value.length) fail('sparse array')
      ancestors.delete(value)
    }
    else fail('unsupported config value')
    if (bytes > 256 * 1024) fail('config byte bound')
  }
  walk(input, 0)
}
function point(input: unknown): asserts input is VolumeXY {
  if (!Array.isArray(input) || input.length !== 2) fail('north/east point')
  for (const n of input) number(n, -50, 50, 'local coordinate')
}
function polygon(input: unknown): asserts input is VolumeXY[] {
  if (!Array.isArray(input) || input.length < 3 || input.length > 32) fail('polygon vertex budget')
  for (const p of input) point(p)
  for (let i = 0; i < input.length; i++) {
    const a = input[i]!, b = input[(i + 1) % input.length]!, previous = input[(i + input.length - 1) % input.length]!
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6 || volumeOnSegment(b, previous, a) || volumeOnSegment(previous, a, b)) fail('degenerate or backtracking polygon edge')
    for (let j = i + 1; j < input.length; j++) {
      if (j === i + 1 || i === 0 && j === input.length - 1) continue
      if (volumeSegmentsTouch(a, b, input[j]!, input[(j + 1) % input.length]!)) fail('self-intersecting polygon')
    }
  }
  if (Math.abs(volumeSignedArea(input)) < 1e-6) fail('degenerate polygon area')
  volumeTriangulateRing(input)
}
function intersectionEngine() {
  let operations = 0
  const triangles = new Map<VolumeXY[], VolumeXY[][]>()
  const triangulate = (p: VolumeXY[]) => { let result = triangles.get(p); if (!result) { result = volumeTriangulateRing(p); triangles.set(p, result) } return result }
  return (...rings: VolumeXY[][]) => {
    let pieces = triangulate(rings[0]!)
    for (const ring of rings.slice(1)) {
      const next: VolumeXY[][] = []
      for (const subject of pieces) for (const triangle of triangulate(ring)) {
        if (++operations > 2000000) fail('exact polygon intersection operation budget')
        const clipped = volumeIntersectConvex(subject, triangle)
        if (clipped.length >= 3 && Math.abs(volumeSignedArea(clipped)) > 1e-12) next.push(clipped)
        if (next.length > 32768) fail('exact polygon intersection piece budget')
      }
      pieces = next
    }
    return pieces.reduce((sum, p) => sum + Math.abs(volumeSignedArea(p)), 0)
  }
}

/** Strict inert-material model validation. Local requirements always remain unqualified. */
export function validateApplicationConfig(input: unknown): ApplicationConfig {
  bounded(input)
  fields(input, ['version', 'id', 'frame', 'origin', 'boundary', 'exclusions', 'prescription', 'routeM', 'gridResolutionM', 'material', 'implement', 'calibration', 'weather', 'weatherLimits', 'localRequirements'])
  const c = input as unknown as ApplicationConfig
  if (c.version !== 1 || c.frame !== 'LOCAL_NED') fail('version or frame'); id(c.id)
  fields(c.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'])
  if (c.origin.latitudeDeg !== 0 || c.origin.longitudeDeg !== 0 || c.origin.ellipsoidHeightM !== 100) fail('owned ground fixture requires origin 0,0,100')
  polygon(c.boundary)
  if (!Array.isArray(c.exclusions) || c.exclusions.length > 8 || !Array.isArray(c.prescription) || c.prescription.length > 8) fail('zone or exclusion count')
  for (const ring of c.exclusions) polygon(ring)
  const zoneIds = new Set<string>()
  for (const zone of c.prescription) {
    fields(zone, ['id', 'polygon', 'ratePerHa']); id(zone.id)
    if (zoneIds.has(zone.id)) fail('duplicate prescription identity'); zoneIds.add(zone.id)
    polygon(zone.polygon); number(zone.ratePerHa, 0, 1e6, 'prescribed rate per hectare')
  }
  const intersect = intersectionEngine()
  for (const rings of [c.exclusions, c.prescription.map(zone => zone.polygon)]) for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
    if (intersect(rings[i]!, rings[j]!) > 1e-9) fail('overlapping polygon interiors')
  }
  if (!Array.isArray(c.routeM) || c.routeM.length < 2 || c.routeM.length > 12) fail('explicit dry approach and apply route budget')
  for (const [i, p] of c.routeM.entries()) {
    point(p)
    if (Math.hypot(...p) > 12 || i > 0 && Math.hypot(p[0] - c.routeM[i - 1]![0], p[1] - c.routeM[i - 1]![1]) < .05) fail('route fence or duplicate segment')
  }
  number(c.gridResolutionM, .05, 10, 'grid resolution')
  const [n0, e0, n1, e1] = volumeBounds(c.boundary)
  if (Math.ceil((n1 - n0) / c.gridResolutionM) * Math.ceil((e1 - e0) / c.gridResolutionM) > 512) fail('512 cell grid budget')
  fields(c.material, ['id', 'batch', 'kind', 'unit', 'densityKgPerL', 'initialAmount']); id(c.material.id); id(c.material.batch)
  fields(c.implement, ['type', 'swathM', 'footprintLengthM', 'fallTimeS', 'minSpeedMps', 'maxSpeedMps'])
  const liquid = c.implement.type === 'sprayer'
  if (!liquid && c.implement.type !== 'spreader' || c.material.kind !== (liquid ? 'water' : 'inert-granules') || c.material.unit !== (liquid ? 'L' : 'kg')) fail('inert implement/material/units must agree')
  if (liquid && c.material.densityKgPerL !== 1) fail('modeled water density is 1 kg/L')
  if (!liquid && c.material.densityKgPerL !== null) number(c.material.densityKgPerL, .01, 20, 'declared bulk density')
  number(c.material.initialAmount, 0, 100, 'initial amount')
  number(c.implement.swathM, .05, 5, 'effective swath'); number(c.implement.footprintLengthM, .05, 3, 'footprint length'); number(c.implement.fallTimeS, 0, 2, 'material fall time')
  number(c.implement.minSpeedMps, .01, 1, 'minimum operating speed'); number(c.implement.maxSpeedMps, c.implement.minSpeedMps, 1.5, 'maximum operating speed')
  fields(c.calibration, ['id', 'evidence', 'pulse', 'scale', 'minRatePerSecond', 'maxRatePerSecond', 'primaryCloseMs', 'masterCloseMs', 'energyTauMs', 'noFlowTimeoutMs', 'closingAllowanceMs', 'encoderCounts']); id(c.calibration.id)
  if (c.calibration.evidence !== 'synthetic' || (liquid ? c.calibration.pulse === null : c.calibration.pulse !== null)) fail('synthetic calibration and implement meter kind')
  const pulseFactor = c.calibration.pulse === null ? null : applicationPulseFactor(c.calibration.pulse)
  const scaleFactor = applicationScaleFactor(c.calibration.scale)
  const maximumMassKg = c.material.initialAmount * (liquid ? c.material.densityKgPerL! : 1)
  if (Math.abs(c.calibration.scale.tareRaw) > 1e8 || Math.abs(c.calibration.scale.tareRaw + maximumMassKg * scaleFactor) > 1e8) fail('scale telemetry range')
  if (pulseFactor !== null && c.material.initialAmount * pulseFactor > 1e8) fail('pulse telemetry range')
  number(c.calibration.minRatePerSecond, .00001, 1, 'minimum calibrated flow'); number(c.calibration.maxRatePerSecond, c.calibration.minRatePerSecond, 10, 'maximum calibrated flow')
  number(c.calibration.primaryCloseMs, 20, 2000, 'primary close time'); number(c.calibration.masterCloseMs, 20, 2000, 'master close time'); number(c.calibration.energyTauMs, 10, 1000, 'energy time constant')
  number(c.calibration.noFlowTimeoutMs, 100, 5000, 'no flow timeout'); number(c.calibration.closingAllowanceMs, 100, 10000, 'closing allowance'); number(c.calibration.encoderCounts, 100, 1000000, 'encoder counts')
  if (!Number.isInteger(c.calibration.encoderCounts)) fail('integer encoder counts')
  const quantum = pulseFactor === null ? 1 / scaleFactor : 1 / pulseFactor
  if (c.calibration.noFlowTimeoutMs <= quantum / c.calibration.minRatePerSecond * 1000 + 80) fail('no flow timeout below quantization and transport allowance')
  if (c.calibration.closingAllowanceMs < Math.max(c.calibration.primaryCloseMs, c.calibration.masterCloseMs) + 5 * c.calibration.energyTauMs + c.implement.fallTimeS * 1000 + 80) fail('closing allowance below response and transport budget')
  for (const zone of c.prescription) if (zone.ratePerHa > 0 && (applicationRatePerSecond(zone.ratePerHa, c.implement.minSpeedMps, c.implement.swathM) < c.calibration.minRatePerSecond || applicationRatePerSecond(zone.ratePerHa, c.implement.maxSpeedMps, c.implement.swathM) > c.calibration.maxRatePerSecond)) fail('prescription outside calibrated speed/flow envelope')
  fields(c.weather, ['windMps', 'temperatureC', 'humidityPercent', 'inversion'])
  point(c.weather.windMps); number(c.weather.temperatureC, -30, 60, 'weather temperature'); number(c.weather.humidityPercent, 0, 100, 'weather humidity')
  if (typeof c.weather.inversion !== 'boolean') fail('inversion declaration')
  fields(c.weatherLimits, ['maxWindMps', 'minTemperatureC', 'maxTemperatureC', 'minHumidityPercent', 'maxAgeMs'])
  number(c.weatherLimits.maxWindMps, 0, 10, 'wind limit'); number(c.weatherLimits.minTemperatureC, -30, 60, 'minimum temperature limit'); number(c.weatherLimits.maxTemperatureC, c.weatherLimits.minTemperatureC, 60, 'maximum temperature limit'); number(c.weatherLimits.minHumidityPercent, 0, 100, 'minimum humidity limit'); number(c.weatherLimits.maxAgeMs, 20, 2000, 'weather age bound')
  fields(c.localRequirements, ['status', 'jurisdiction', 'operatorId', 'evidenceLinks']); id(c.localRequirements.operatorId)
  if (c.localRequirements.status !== 'unqualified' || c.localRequirements.jurisdiction !== null && (typeof c.localRequirements.jurisdiction !== 'string' || !/^[A-Za-z0-9 ,.'()/-]{1,120}$/.test(c.localRequirements.jurisdiction))) fail('local requirements remain unqualified')
  if (!Array.isArray(c.localRequirements.evidenceLinks) || c.localRequirements.evidenceLinks.length > 16) fail('local evidence link bound')
  for (const link of c.localRequirements.evidenceLinks) {
    if (typeof link !== 'string' || link.length > 2048) fail('evidence link')
    try { const url = new URL(link); if (url.protocol !== 'https:' || url.username || url.password) fail('evidence link') }
    catch { fail('evidence link') }
  }
  return structuredClone(c)
}

/** Exact prescribed polygon support plus a real bounded owned ground mission. Route completion is not coverage proof. */
export function planApplication(input: unknown): ApplicationPlan {
  const config = validateApplicationConfig(input), intersect = intersectionEngine()
  const fieldAreaM2 = Math.abs(volumeSignedArea(config.boundary)), excludedAreaM2 = config.exclusions.reduce((sum, ring) => sum + intersect(config.boundary, ring), 0)
  const treatableAreaM2 = Math.max(0, fieldAreaM2 - excludedAreaM2)
  let prescribedAmount = 0
  for (const zone of config.prescription) {
    const support = intersect(config.boundary, zone.polygon) - config.exclusions.reduce((sum, exclusion) => sum + intersect(config.boundary, zone.polygon, exclusion), 0)
    prescribedAmount += Math.max(0, support) * zone.ratePerHa / 10000
  }
  const timeout = (from: VolumeXY, to: VolumeXY) => Math.max(5000, Math.ceil((Math.hypot(to[0] - from[0], to[1] - from[1]) / .3 + 6) * 1000))
  const tasks: VehicleMissionTask[] = [{ id: 'start', kind: 'start', next: 'approach' }]
  let previous: VolumeXY = [0, 0]
  for (const [i, p] of config.routeM.entries()) {
    tasks.push({ id: i === 0 ? 'approach' : `apply-${i}`, kind: 'waypoint', positionM: [p[0], p[1], 0], acceptanceM: .22, maxArrivalSpeedMps: .08, settleMs: 300, timeoutMs: timeout(previous, p), next: i === config.routeM.length - 1 ? 'home' : `apply-${i + 1}` })
    previous = p
  }
  tasks.push({ id: 'home', kind: 'return', acceptanceM: .22, maxArrivalSpeedMps: .08, settleMs: 300, timeoutMs: timeout(previous, [0, 0]), next: 'stop' }, { id: 'stop', kind: 'stop', positionM: [0, 0, 0], acceptanceM: .25, maxArrivalSpeedMps: .1, settleMs: 300, timeoutMs: 3000 })
  const mission: VehicleMissionPlan = { version: 2, vehicle: 'ground', id: config.id, frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { ...config.origin }, fence: { radiusM: 12, minDownM: -.3, maxDownM: .3 }, rallyM: [0, 0, 0], power: { availableWh: 100, maxW: 250, reservePercent: 30 }, start: 'start', tasks }
  const validated = validateVehicleMission(mission)
  if (validated.worstCaseMs > 120000) fail('120 second application mission budget')
  return { config, mission: validated.plan, fieldAreaM2, excludedAreaM2, treatableAreaM2, prescribedAmount, availableAmount: config.material.initialAmount, inventorySufficient: config.material.initialAmount + 1e-12 >= prescribedAmount, worstCaseMs: validated.worstCaseMs, requiredWh: validated.requiredWh, physicalTrialEligible: false }
}
