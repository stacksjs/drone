import type { ApplicationRun, ApplicationControllerInput } from './runtime-types'
import type { ApplicationPlantSnapshot } from './types'
import { replayVehicleMission } from '../missions/vehicle'
import { createVehicleMeasurementQualifier } from '../vehicles/measurements'
import { applicationPulseFactor, applicationScaleFactor } from './calibration'
import { createApplicationController } from './controller'
import { planApplication, validateApplicationConfig } from './planner'

export const applicationEvidenceLimits = Object.freeze({ recordingBytes: 16 * 1024 * 1024, hostRows: 9001, probes: 10001, releases: 10001, maximumMs: 200000 })
function fail(reason: string): never { throw new TypeError(`Invalid application recording: ${reason}`) }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype }
function fields(v: unknown, expected: readonly string[]) {
  if (!record(v)) fail('expected record')
  let count = 0
  for (const key in v) if (!expected.includes(key) || ++count > expected.length) fail('unsupported fields')
  if (count !== expected.length || expected.some(key => !Object.hasOwn(v, key))) fail('missing fields')
}
function finite(v: unknown, min = -1000000, max = 1000000): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max }
function epoch(v: unknown): v is number { return Number.isSafeInteger(v) && finite(v, 0, applicationEvidenceLimits.maximumMs) }
function vector(v: unknown, size: number): v is number[] { return Array.isArray(v) && v.length === size && v.every(n => finite(n)) }
function identifier(v: unknown): v is string { return typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v) }
function text(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 1000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v) }
function equivalent(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b))
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equivalent(v, b[i]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]))
}
/** Bounded plain data only; no typed/shared memory, prototypes, accessors or implicit scalar conversion. */
function bounded(input: unknown) {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const add = (n: number) => { bytes += n; if (bytes > applicationEvidenceLimits.recordingBytes) fail('recording exceeds 16 MiB') }
  function visit(v: unknown, depth: number): void {
    if (++nodes > 4 * 1024 * 1024 || depth > 32) fail('recording structure resource bound')
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('non-finite number'); add(String(v).length) }
    else if (typeof v === 'bigint') { if (v < 0n || v > 0xFFFFFFFFFFFFFFFFn) fail('uint64 diagnostic range'); add(v.toString().length + 25) }
    else if (typeof v === 'string') { if (v.length > 4096) fail('text resource bound'); add(new TextEncoder().encode(JSON.stringify(v)).length) }
    else if (typeof v === 'boolean' || v === null) add(v === true ? 4 : 5)
    else if (Array.isArray(v) || record(v)) {
      const array = Array.isArray(v)
      if (array && (Object.getPrototypeOf(v) !== Array.prototype || v.length > applicationEvidenceLimits.probes)) fail('array prototype or resource bound')
      if (ancestors.has(v)) fail('cyclic recording')
      if (Object.getOwnPropertySymbols(v).length) fail('symbolic recording fields')
      ancestors.add(v); add(2)
      let count = 0
      for (const key in v) {
        if (!Object.hasOwn(v, key)) fail('inherited recording fields')
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!
        if (!('value' in descriptor)) fail('accessor recording fields')
        if (array && key !== String(count)) fail('sparse or extended recording array')
        if (++count > applicationEvidenceLimits.probes) fail('object resource bound')
        add((count > 1 ? 1 : 0) + (array ? 0 : new TextEncoder().encode(JSON.stringify(key)).length + 1)); visit(descriptor.value, depth + 1)
      }
      if (array && count !== v.length) fail('sparse recording array')
      // Non-enumerable application data has no wire representation and cannot hide a getter or scalar override.
      for (const key of Object.getOwnPropertyNames(v)) if (!(array && key === 'length') && !Object.getOwnPropertyDescriptor(v, key)!.enumerable) fail('non-enumerable recording fields')
      ancestors.delete(v)
    }
    else fail('unsupported memory, prototype or recording value')
  }
  visit(input, 0)
}
function plant(state: ApplicationPlantSnapshot, config: ApplicationRun['config'], previous?: ApplicationPlantSnapshot) {
  fields(state, ['atMs', 'primaryPosition', 'masterPosition', 'energy', 'flowPerSecond', 'remainingAmount', 'emittedAmount', 'unmeteredLossAmount', 'pulseCount', 'scaleRaw'])
  if (!epoch(state.atMs) || ![state.primaryPosition, state.masterPosition, state.energy].every(n => finite(n, 0, 1)) || !finite(state.flowPerSecond, 0, config.calibration.maxRatePerSecond * 1.001) || ![state.remainingAmount, state.emittedAmount, state.unmeteredLossAmount].every(n => finite(n, 0, config.material.initialAmount + 1e-8)) || !Number.isSafeInteger(state.pulseCount) || state.pulseCount < 0 || !Number.isSafeInteger(state.scaleRaw) || Math.abs(state.scaleRaw) > 1e12 || !equivalent(config.material.initialAmount, state.remainingAmount + state.emittedAmount + state.unmeteredLossAmount)) fail('plant inventory or quantities')
  if (previous && (state.atMs <= previous.atMs || state.emittedAmount < previous.emittedAmount || state.unmeteredLossAmount < previous.unmeteredLossAmount || state.remainingAmount > previous.remainingAmount + 1e-10 || state.pulseCount < previous.pulseCount)) fail('plant clock, inventory or counter reversal')
  if (config.calibration.pulse) { const pulses = state.emittedAmount * applicationPulseFactor(config.calibration.pulse); if (Math.abs(state.pulseCount - pulses) > 1.000001) fail('plant pulse accounting') }
  const kg = state.remainingAmount * (config.material.unit === 'L' ? config.material.densityKgPerL! : 1)
  if (Math.abs(state.scaleRaw - config.calibration.scale.tareRaw - kg * applicationScaleFactor(config.calibration.scale)) > .500001) fail('plant scale accounting')
}
function controllerInput(input: ApplicationControllerInput) {
  fields(input, ['atMs', 'enabled', 'reference', 'missionState', 'taskId', 'ground', 'feedback', 'weather', 'grant', 'emergency'])
  if (!epoch(input.atMs) || typeof input.enabled !== 'boolean' || typeof input.emergency !== 'boolean' || typeof input.reference !== 'string' || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(input.reference) || !['ready', 'running', 'paused', 'completed', 'aborted', 'blocked'].includes(input.missionState) || !identifier(input.taskId)) fail('controller input scope or epoch')
  fields(input.ground, ['healthy', 'reason', 'positionM', 'speedMps', 'wheelSpeedMps', 'yawRad', 'yawRateRadS', 'obstacleM', 'personM', 'onSurface', 'stopped', 'guardClosed', 'emergency', 'uncertaintyM'])
  const ground = input.ground
  if (![ground.healthy, ground.onSurface, ground.stopped, ground.guardClosed, ground.emergency].every(n => typeof n === 'boolean') || !text(ground.reason) || !vector(ground.positionM, 3) || ![ground.speedMps, ground.wheelSpeedMps, ground.yawRad, ground.yawRateRadS].every(n => finite(n, -1000, 1000)) || ![ground.obstacleM, ground.personM, ground.uncertaintyM].every(n => finite(n, 0, 1000))) fail('recorded ground observation')
  fields(input.weather, ['windMps', 'temperatureC', 'humidityPercent', 'inversion', 'capturedAtMs'])
  if (!vector(input.weather.windMps, 2) || !finite(input.weather.temperatureC, -100, 100) || !finite(input.weather.humidityPercent, 0, 100) || typeof input.weather.inversion !== 'boolean' || !epoch(input.weather.capturedAtMs)) fail('weather declaration')
  if (input.feedback !== null) {
    fields(input.feedback, ['sequence', 'capturedAtMs', 'pulseCount', 'scaleRaw', 'primaryEncoder', 'masterEncoder', 'energyEncoder'])
    if (!epoch(input.feedback.capturedAtMs) || ![input.feedback.sequence, input.feedback.pulseCount, input.feedback.scaleRaw, input.feedback.primaryEncoder, input.feedback.masterEncoder, input.feedback.energyEncoder].every(Number.isSafeInteger) || input.feedback.sequence < 0 || input.feedback.pulseCount < 0) fail('meter feedback declaration')
  }
  if (input.grant !== null) {
    fields(input.grant, ['action', 'sequence', 'issuedAtMs', 'expiresAtMs', 'visitId', 'configId', 'materialId', 'reference'])
    if (!['grant', 'renew', 'revoke'].includes(input.grant.action) || !Number.isSafeInteger(input.grant.sequence) || input.grant.sequence < 0 || !epoch(input.grant.issuedAtMs) || !epoch(input.grant.expiresAtMs) || ![input.grant.visitId, input.grant.configId, input.grant.materialId].every(identifier) || typeof input.grant.reference !== 'string' || input.grant.reference.length > 120) fail('grant declaration')
  }
}
function uint64(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n && value <= 0xFFFFFFFFFFFFFFFFn }
/** Replay recorded mission and implement inputs. This verifies unsigned consistency, not producer authenticity or full sensor/plant replay. */
export function validateApplicationRun(input: unknown): ApplicationRun {
  bounded(input)
  fields(input, ['version', 'evidence', 'physicalFlightEnabled', 'physicalApplicationVerified', 'physicalTrialEligible', 'options', 'config', 'plan', 'vehicle', 'inputs', 'decisions', 'releases', 'probes', 'final', 'shutdown', 'status', 'reason', 'faultDemonstrated'])
  const source = input as ApplicationRun
  if (source.version !== 1 || source.evidence !== 'owned-application-physics-simulation' || source.physicalFlightEnabled !== false || source.physicalApplicationVerified !== false || source.physicalTrialEligible !== false || !['dry-completed', 'completed', 'blocked', 'host-lost', 'incomplete'].includes(source.status) || !text(source.reason) || typeof source.faultDemonstrated !== 'boolean') fail('unsupported application evidence')
  fields(source.options, ['scenario', 'visitId', 'seconds', 'authorizeImplement', 'testMode'])
  if (!identifier(source.options.visitId) || !['nominal', 'empty', 'stuck-valve', 'master-stuck', 'blocked-flow', 'meter-loss', 'meter-replay', 'weather', 'manual', 'host-loss', 'emergency', 'localization-loss', 'guard-open', 'lease-expiry'].includes(source.options.scenario) || !Number.isSafeInteger(source.options.seconds) || source.options.seconds < 2 || source.options.seconds > 180 || typeof source.options.authorizeImplement !== 'boolean' || typeof source.options.testMode !== 'boolean') fail('normalized application options')
  const config = validateApplicationConfig(source.config), plan = planApplication(config)
  if (!equivalent(source.plan, plan) || !Array.isArray(source.inputs) || !source.inputs.length || source.inputs.length > applicationEvidenceLimits.hostRows || !Array.isArray(source.decisions) || source.decisions.length !== source.inputs.length || !Array.isArray(source.probes) || !source.probes.length || source.probes.length > applicationEvidenceLimits.probes || !Array.isArray(source.releases) || source.releases.length > applicationEvidenceLimits.releases) fail('plan or recording counts')
  const run = structuredClone(source), vehicle = run.vehicle
  fields(vehicle, ['version', 'evidence', 'physicalFlightEnabled', 'boardOutputsInhibited', 'vehicle', 'scenario', 'status', 'fault', 'navigationEvidence', 'mission', 'trace', 'path', 'transitions', 'budget', 'authority', 'board', 'finalTruthPositionM'])
  if (vehicle.version !== 1 || vehicle.evidence !== 'owned-vehicle-physics-simulation' || vehicle.physicalFlightEnabled !== false || vehicle.boardOutputsInhibited !== true || vehicle.vehicle !== 'ground' || !['completed', 'blocked', 'host-lost', 'duration-exhausted'].includes(vehicle.status) || (vehicle.fault !== null && !text(vehicle.fault)) || !vector(vehicle.finalTruthPositionM, 3) || !equivalent(vehicle.trace.plan, plan.mission) || !Array.isArray(vehicle.trace.rows) || vehicle.trace.rows.length !== run.inputs.length || !Array.isArray(vehicle.path) || vehicle.path.length !== run.inputs.length) fail('vehicle profile, trace or host epochs')
  const mission = replayVehicleMission(vehicle.trace).snapshot()
  if (!equivalent(mission, vehicle.mission) || !equivalent(vehicle.budget, { worstCaseMs: plan.worstCaseMs, requiredWh: plan.requiredWh })) fail('replayed mission or energy budget')
  fields(vehicle.navigationEvidence, ['observedSensors', 'datum', 'quality', 'localPositionHealthy'])
  fields(vehicle.navigationEvidence.observedSensors, ['imu', 'gnss'])
  if (![vehicle.navigationEvidence.observedSensors.imu, vehicle.navigationEvidence.observedSensors.gnss].every(n => Number.isSafeInteger(n) && n >= 0) || typeof vehicle.navigationEvidence.localPositionHealthy !== 'boolean' || !Array.isArray(vehicle.navigationEvidence.quality) || vehicle.navigationEvidence.quality.length > 64 || vehicle.navigationEvidence.quality.some(n => !text(n)) || (vehicle.navigationEvidence.datum !== null && vehicle.navigationEvidence.datum !== 'WGS84_ELLIPSOID')) fail('navigation declarations')
  fields(vehicle.authority, ['version', 'state', 'epoch', 'sessionId', 'bootId', 'sequence', 'lastCheckedAtMs', 'reason', 'commandAccepted', 'leaseUntilMs', 'target', 'physicalFlightEnabled', 'boardOutputsInhibited', 'events', 'vehicle', 'physicalActuationEnabled'])
  fields(vehicle.board, ['bootId', 'lastCheckedAtMs', 'sequence', 'epoch', 'expiresAtMs', 'fault', 'physicalFlightEnabled', 'boardOutputsInhibited', 'vehicle', 'actuators', 'physicalActuationEnabled'])
  if (!uint64(vehicle.authority.bootId) || !uint64(vehicle.authority.sessionId) || !uint64(vehicle.board.bootId) || vehicle.authority.bootId !== vehicle.board.bootId || vehicle.authority.physicalFlightEnabled !== false || vehicle.authority.physicalActuationEnabled !== false || vehicle.board.physicalFlightEnabled !== false || vehicle.board.physicalActuationEnabled !== false || vehicle.authority.vehicle !== 'ground' || vehicle.board.vehicle !== 'ground' || !vector(vehicle.board.actuators, 7)) fail('native diagnostic scope or physical flags')
  const controller = createApplicationController(config, { visitId: run.options.visitId, authorizeImplement: run.options.authorizeImplement, testMode: run.options.testMode }), qualifier = createVehicleMeasurementQualifier('ground')
  let previousMs = -1
  const transitions: ApplicationRun['vehicle']['transitions'] = []
  let previousState = '', previousTask = ''
  for (let i = 0; i < run.inputs.length; i++) {
    const recorded = run.inputs[i]!, row = vehicle.path[i]!, trace = vehicle.trace.rows[i]!
    controllerInput(recorded)
    fields(row, ['atMs', 'positionM', 'truthPositionM', 'mission', 'measurement', 'measurementPose', 'actuators'])
    if (recorded.atMs <= previousMs || recorded.atMs !== row.atMs || row.atMs !== trace.observation.nowMs || recorded.reference !== trace.observation.reference || recorded.taskId !== row.mission.taskId || recorded.missionState !== row.mission.state || !equivalent(row.mission, trace.result) || (row.positionM !== null && (!vector(row.positionM, 3) || !equivalent(row.positionM, trace.observation.positionM))) || !vector(row.truthPositionM, 3) || !vector(row.actuators, 7) || (recorded.enabled && trace.observation.authority !== 'autonomous')) fail('host input, mission or pose epoch mismatch')
    if (recorded.ground.healthy && (!row.positionM || Math.hypot(...recorded.ground.positionM.map((n, j) => n - row.positionM![j]!)) > recorded.ground.uncertaintyM + config.implement.maxSpeedMps * .14)) fail('qualified ground observation diverges beyond declared uncertainty and latency travel')
    if (row.measurement !== null) {
      fields(row.measurement, ['version', 'evidence', 'vehicle', 'sequence', 'reference', 'capturedAtMs', 'receivedAtMs', 'values'])
      qualifier.qualify(row.measurement, row.atMs, recorded.reference)
    }
    if (recorded.feedback) {
      const values = row.measurement?.values, feedback = recorded.feedback
      if (!values || feedback.sequence !== values.applicationMeterSequence || feedback.capturedAtMs !== values.applicationMeterAtMs || feedback.pulseCount !== values.applicationPulseCount || feedback.scaleRaw !== values.applicationScaleRaw || feedback.primaryEncoder !== values.applicationPrimaryEncoder || feedback.masterEncoder !== values.applicationMasterEncoder || feedback.energyEncoder !== values.applicationEnergyEncoder || values.applicationCalibration !== config.calibration.id) fail('meter input differs from recorded sensor packet')
    }
    if (row.measurementPose !== null) {
      fields(row.measurementPose, ['reference', 'capturedAtMs', 'positionM', 'quaternionWxyz', 'positionCapturedAtMs', 'positionPredictedToMs', 'attitudeCapturedAtMs', 'attitudePredictedToMs', 'gyroCapturedAtMs', 'attitudePrediction'])
      const pose = row.measurementPose
      if (!row.measurement || pose.reference !== row.measurement.reference || pose.capturedAtMs !== row.measurement.capturedAtMs || !vector(pose.positionM, 3) || !vector(pose.quaternionWxyz, 4) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 1e-6 || pose.attitudePrediction !== 'qualified-gyro-hold' || pose.positionPredictedToMs !== pose.capturedAtMs || pose.attitudePredictedToMs !== pose.capturedAtMs || !epoch(pose.positionCapturedAtMs) || !epoch(pose.attitudeCapturedAtMs) || !epoch(pose.gyroCapturedAtMs) || pose.positionCapturedAtMs > pose.capturedAtMs || pose.attitudeCapturedAtMs > pose.capturedAtMs || pose.gyroCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.positionCapturedAtMs > 200 || pose.capturedAtMs - pose.attitudeCapturedAtMs > 60 || pose.capturedAtMs - pose.gyroCapturedAtMs > 80) fail('measurement pose epoch or qualification')
    }
    const expected = controller.step(recorded)
    if (!equivalent(expected, run.decisions[i])) fail('implement decision differs from replayed qualified inputs')
    if (row.mission.state !== previousState || row.mission.taskId !== previousTask) { transitions.push({ atMs: row.atMs, state: row.mission.state, taskId: row.mission.taskId, reason: row.mission.reason }); previousState = row.mission.state; previousTask = row.mission.taskId }
    previousMs = recorded.atMs
  }
  if (!equivalent(transitions, vehicle.transitions)) fail('vehicle transition log differs from mission replay')
  fields(run.shutdown, ['requestedAtMs', 'finalAtMs', 'emittedAfterRequest', 'closureVerified', 'evidence'])
  if (!epoch(run.shutdown.requestedAtMs) || !epoch(run.shutdown.finalAtMs) || run.shutdown.requestedAtMs > run.shutdown.finalAtMs || run.shutdown.finalAtMs < previousMs || !finite(run.shutdown.emittedAfterRequest, 0) || typeof run.shutdown.closureVerified !== 'boolean' || run.shutdown.evidence !== 'independent-modeled-plant-tail') fail('shutdown declaration')
  let previousPlant: ApplicationPlantSnapshot | undefined, emitted = 0, emittedBeforeRequest = 0, releaseIndex = 0
  for (const probe of run.probes) {
    fields(probe, ['atMs', 'hostAvailable', 'positionM', 'yawRad', 'state', 'boardChannels'])
    if (!epoch(probe.atMs) || probe.atMs !== probe.state.atMs || !vector(probe.positionM, 3) || !finite(probe.yawRad, -1000, 1000) || typeof probe.hostAvailable !== 'boolean' || !vector(probe.boardChannels, 7) || (probe.hostAvailable && probe.atMs > previousMs)) fail('independent probe scope')
    plant(probe.state, config, previousPlant)
    const next = run.releases[releaseIndex], delta = probe.state.emittedAmount - (previousPlant?.emittedAmount ?? 0)
    if (next && next.atMs < probe.atMs) fail('release has no matching plant probe')
    if (next?.atMs === probe.atMs) {
      fields(next, ['atMs', 'amount', 'positionM', 'yawRad', 'windMps', 'taskId', 'hostAvailable', 'positionEvidence'])
      const decision = run.decisions.findLast(item => item.atMs < next.atMs)
      if (!finite(next.amount, 0) || !equivalent(next.amount, delta) || !equivalent(next.positionM, probe.positionM) || !equivalent(next.yawRad, probe.yawRad) || next.hostAvailable !== probe.hostAvailable || next.positionEvidence !== 'modeled-plant-truth' || !vector(next.windMps, 2) || next.taskId !== (probe.hostAvailable ? decision?.taskId ?? null : null)) fail('release differs from actual probe delta, position or pass scope')
      emitted += next.amount
      if (next.atMs <= run.shutdown.requestedAtMs) emittedBeforeRequest += next.amount
      releaseIndex++
    }
    else if (!equivalent(delta, 0)) fail('emitted material is missing a release record')
    previousPlant = probe.state
  }
  plant(run.final, config)
  if (!previousPlant || !equivalent(previousPlant, run.final) || releaseIndex !== run.releases.length || !equivalent(emitted, run.final.emittedAmount) || !equivalent(run.shutdown.emittedAfterRequest, emitted - emittedBeforeRequest) || run.final.atMs !== run.shutdown.finalAtMs) fail('final inventory, releases or residual shutdown accounting')
  const closed = run.final.masterPosition <= .001 && run.final.energy <= .001 && run.final.flowPerSecond <= 1e-10 && run.shutdown.finalAtMs - run.shutdown.requestedAtMs >= config.calibration.closingAllowanceMs
  if (run.shutdown.closureVerified !== closed) fail('shutdown closure claim differs from independent final probe')
  if (run.status === 'completed' && (vehicle.status !== 'completed' || !run.options.authorizeImplement || run.options.testMode || !closed || run.final.emittedAmount <= 0) || run.status === 'dry-completed' && (vehicle.status !== 'completed' || run.final.emittedAmount !== 0) || run.status === 'host-lost' && vehicle.status !== 'host-lost' || run.status === 'incomplete' && vehicle.status !== 'duration-exhausted') fail('aggregate application status differs from vehicle or material evidence')
  if (run.faultDemonstrated && (run.options.scenario === 'nominal' || run.final.emittedAmount <= 0 || !['blocked', 'host-lost'].includes(run.status))) fail('premature or unexercised fault claim')
  return { ...run, config, plan }
}
export function applicationRecordingJson(input: ApplicationRun): string {
  const run = validateApplicationRun(input)
  return JSON.stringify(run, (_key, value) => typeof value === 'bigint' ? { $applicationUint64: value.toString() } : value)
}
export function parseApplicationRecording(text: string): ApplicationRun {
  if (typeof text !== 'string' || text.length > applicationEvidenceLimits.recordingBytes) fail('recording exceeds 16 MiB')
  if (new TextEncoder().encode(text).length > applicationEvidenceLimits.recordingBytes) fail('recording exceeds 16 MiB')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new TypeError('Invalid application recording JSON') }
  bounded(value)
  const run = value as ApplicationRun
  if (!record(run?.vehicle) || !record(run.vehicle.authority) || !record(run.vehicle.board)) fail('missing native diagnostic records')
  for (const [target, key] of [[run.vehicle.authority, 'bootId'], [run.vehicle.authority, 'sessionId'], [run.vehicle.board, 'bootId']] as const) {
    const encoded = target[key] as unknown
    fields(encoded, ['$applicationUint64'])
    const decimal = (encoded as { $applicationUint64: unknown }).$applicationUint64
    if (typeof decimal !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(decimal)) fail('invalid uint64 diagnostic encoding')
    const n = BigInt(decimal)
    if (!uint64(n)) fail('uint64 diagnostic range')
    target[key] = n
  }
  return validateApplicationRun(run)
}
