import type { Quaternion } from '../../estimation/frames'
import type { SensorVector } from '../../sensors/types'
import type { VehicleBatteryObservation, VehicleController, VehicleControllerContext, VehicleVtolBackCaptureForecast, VehicleVtolBackCaptureModel, VehicleVtolBackCapturePolicy, VehicleVtolBackCapturePrediction, VehicleVtolTransitionCommand } from '../types'
import { rotateNedToBody } from '../../controls/physics'
import { captureVehicleBatteryModel, createVehicleMeasurementQualifier, observeVehicleBattery } from '../measurements'
import { createVtolPlant, vtolModel } from './plant'
import { renderVtolElectricalMeasurement } from './power'
import { numericPacket } from './packets'

/** Declared fictional forecast assumptions, not measured aircraft uncertainty or a reachability proof. */
export const vtolBackCaptureModel = Object.freeze({ version: 'model-scenarios-v2', maximumBrakingPitchRad: 0.4, landingFlare: 'critical-damped', attitudeSampleRad: 0.03, airQuantizationMps: 0.02, maximumAirspeedMps: 22, maximumWindMps: 3, deadlineMarginMs: 1500, maximumPredictions: 28, maximumWaitMs: 24000 } satisfies VehicleVtolBackCaptureModel)
export interface VtolForecastControl extends VehicleController { scheduleBrake(atMs: number): void, rotaryCaptured(): boolean }
export interface VtolForecastInitial { positionM: SensorVector, velocityMps: SensorVector, quaternionWxyz: Quaternion, angularRateRadS: SensorVector }

function dataRecord(input: unknown, fields: string[]): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== fields.length) return null
  const result: Record<string, unknown> = {}
  for (const field of fields) { const slot = Object.getOwnPropertyDescriptor(input, field); if (!slot || !('value' in slot)) return null; result[field] = slot.value }
  return result
}
export function validVtolBackCapturePolicy(input: unknown): input is VehicleVtolBackCapturePolicy {
  const policy = dataRecord(input, ['method', 'remainingMissionMs', 'power', 'fence'])
  if (!policy || policy.method !== 'bounded-approach-v1' || !Number.isSafeInteger(policy.remainingMissionMs) || (policy.remainingMissionMs as number) < 100 || (policy.remainingMissionMs as number) > 180000) return false
  const power = dataRecord(policy.power, ['availableWh', 'maxW', 'reservePercent']), fence = dataRecord(policy.fence, ['radiusM', 'minDownM', 'maxDownM'])
  if (!power || !fence || [...Object.values(power), ...Object.values(fence)].some(value => typeof value !== 'number' || !Number.isFinite(value))) return false
  return (power.availableWh as number) >= 0.01 && (power.availableWh as number) <= 10000 && (power.maxW as number) >= 1 && (power.maxW as number) <= 100000 && (power.reservePercent as number) >= 26 && (power.reservePercent as number) <= 80
    && (fence.radiusM as number) >= 1 && (fence.radiusM as number) <= 400 && (fence.minDownM as number) >= -40 && (fence.minDownM as number) <= 0 && (fence.maxDownM as number) >= 0 && (fence.maxDownM as number) <= 1 && (fence.minDownM as number) < (fence.maxDownM as number)
}

/** Uses the same source envelope, replay checks and capture-age charge as the owned runtime. */
export function createVtolBackCaptureResourceObserver(request: VehicleVtolTransitionCommand) {
  if (!validVtolBackCapturePolicy(request.planning)) throw new TypeError('Unqualified VTOL capture policy')
  const command = structuredClone(request), policy = command.planning!
  const model = captureVehicleBatteryModel({ evidence: 'modeled-vehicle-battery-v1', capacityWh: policy.power.availableWh, maximumSourceW: policy.power.maxW }, policy.power)!
  const qualifier = createVehicleMeasurementQualifier('vtol', model)
  return (c: VehicleControllerContext): { reason: string, battery: VehicleBatteryObservation | null, requiredWh: number } => {
    // Fund the whole original capture deadline and the remaining validated DAG, even if a
    // selected model trace forecasts an earlier hover. A forecast is not an energy grant.
    const requiredWh = policy.power.maxW * (Math.max(0, command.expiresAtMs - c.nowMs) + policy.remainingMissionMs) / 3600000
    let battery: VehicleBatteryObservation
    try {
      const measurement = qualifier.qualify(c.measurement, c.nowMs, command.reference)
      if (!measurement) throw new TypeError('Unavailable battery observation')
      battery = observeVehicleBattery(measurement, model, c.nowMs)
    }
    catch { return { reason: 'forecast-source-envelope-unqualified', battery: null, requiredWh } }
    return { reason: battery.cutoff ? 'forecast-source-cutoff' : battery.remainingWhLowerBound - requiredWh < model.capacityWh * policy.power.reservePercent / 100 ? 'forecast-reserve-exhausted' : '', battery, requiredWh }
  }
}

export interface VtolBackCaptureMotion {
  status: 'fresh' | 'stale' | 'unqualified'
  sourceCapturedAtMs: number | null
  windMps: SensorVector | null
  sampleRadiusMps: number | null
}
/** The wind subtraction always uses navigation and airflow retained at the same capture. */
export function observeVtolBackCaptureMotion(c: VehicleControllerContext, request: VehicleVtolTransitionCommand, airNed: SensorVector): VtolBackCaptureMotion {
  const pose = c.measurementPose, m = c.measurement, p = c.estimate.localPosition, rate = c.controlRate
  const result: VtolBackCaptureMotion = { status: 'unqualified', sourceCapturedAtMs: null, windMps: null, sampleRadiusMps: null }
  if (!pose || !m || !p || p.capturedAtMs === null || !rate) return result
  const source = Math.min(m.capturedAtMs, pose.positionCapturedAtMs, pose.attitudeCapturedAtMs, pose.gyroCapturedAtMs, p.capturedAtMs, rate.capturedAtMs)
  result.sourceCapturedAtMs = Number.isSafeInteger(source) && source >= 0 ? source : null
  let velocity: number[], air: number[], variances: number[]
  try {
    velocity = numericPacket(pose.velocityMps, 3); air = numericPacket(airNed, 3)
    const cov = pose.covarianceBlocks
    if (!Array.isArray(cov) || cov.length !== 3) return result
    variances = [0, 1, 2].map(index => {
      const slot = Object.getOwnPropertyDescriptor(cov, String(index))
      if (!slot?.enumerable || !('value' in slot)) throw new TypeError('Unavailable covariance axis')
      const axis = dataRecord(slot.value, ['positionM2', 'positionVelocityM2S', 'velocityM2S2'])
      if (!axis || Object.values(axis).some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new TypeError('Unqualified covariance axis')
      const position = axis.positionM2 as number, cross = axis.positionVelocityM2S as number, variance = axis.velocityM2S2 as number
      if (position <= 0 || variance <= 0 || cross ** 2 > position * variance * (1 + 1e-6)) throw new TypeError('Non-PSD covariance axis')
      return variance
    })
  }
  catch { return result }
  if (result.sourceCapturedAtMs === null || Math.hypot(...velocity) > 100 || Math.hypot(...air) > vtolBackCaptureModel.maximumAirspeedMps) return result
  const wind = velocity.map((n, i) => n - air[i]!) as SensorVector
  const radius = 3 * Math.sqrt(Math.max(...variances)) + vtolBackCaptureModel.airQuantizationMps + Math.hypot(...air) * vtolBackCaptureModel.attitudeSampleRad
  if (!wind.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0) return result
  result.windMps = wind; result.sampleRadiusMps = radius
  result.status = source < request.issuedAtMs || c.nowMs - source > 120 ? 'stale' : 'fresh'
  return result
}

/** Forecasts are private model executions. They never become received sensors or mission confirmations. */
export function forecastVtolBackCapture(c: VehicleControllerContext, request: VehicleVtolTransitionCommand, initial: VtolForecastInitial, airNed: SensorVector, fork: () => VtolForecastControl): VehicleVtolBackCaptureForecast {
  const m = c.measurement!, pose = c.measurementPose!, policy = request.planning!
  const motion = observeVtolBackCaptureMotion(c, request, airNed), source = motion.sourceCapturedAtMs
  const report: VehicleVtolBackCaptureForecast = { evidence: 'modeled-vtol-back-capture-forecast-v1', physicalFlightEnabled: false, model: { ...vtolBackCaptureModel }, eventId: request.eventId, reference: request.reference, observedAtMs: c.nowMs, sourceCapturedAtMs: source, anchorM: [...request.positionM], status: 'uncertain', reason: 'capture-motion-unqualified', windMps: null, windSampleRadiusMps: null, remainingWhLowerBound: null, waitMs: null, brakeAtMs: null, predictions: [] }
  const cov = pose.covarianceBlocks
  if (motion.status !== 'fresh' || !motion.windMps || motion.sampleRadiusMps === null || !cov) { report.reason = motion.status === 'stale' ? 'capture-motion-stale' : 'capture-motion-unqualified'; return report }
  if (!validVtolBackCapturePolicy(policy)) { report.reason = 'capture-policy-unqualified'; return report }
  // Predeclare the attitude contribution at the entire admitted airspeed ceiling.
  // Later observations must fit this sampled radius; they never expand it in flight.
  const wind = motion.windMps, radius = motion.sampleRadiusMps + (vtolBackCaptureModel.maximumAirspeedMps - Math.hypot(...airNed)) * vtolBackCaptureModel.attitudeSampleRad
  report.windMps = wind; report.windSampleRadiusMps = radius
  if (Math.hypot(...wind) + radius > vtolBackCaptureModel.maximumWindMps) { report.reason = 'wind-outside-forecast-model'; return report }
  const values = m.values, capacity = policy.power.availableWh
  const resources = createVtolBackCaptureResourceObserver(request)(c)
  if (resources.reason || !resources.battery || (values.rotorThrustN as number) > 0.05) { report.reason = resources.reason || 'forecast-source-envelope-unqualified'; return report }
  const remaining = resources.battery.remainingWhLowerBound
  report.remainingWhLowerBound = remaining
  const horizonMs = request.expiresAtMs - c.nowMs - vtolBackCaptureModel.deadlineMarginMs
  if (horizonMs <= 0) { report.status = 'limit'; report.reason = 'forecast-deadline-exhausted'; return report }
  const reserveWh = capacity * policy.power.reservePercent / 100
  function run(waitMs: number, predictedWind: SensorVector, role: VehicleVtolBackCapturePrediction['role']) {
    if (report.predictions.length >= vtolBackCaptureModel.maximumPredictions) throw new RangeError('VTOL forecast computation budget exhausted')
    const control = fork(), model = createVtolPlant({ ...initial, rotorsN: Array(4).fill((values.rotorThrustN as number) / 4) as [number, number, number, number], pusherThrustN: values.pusherThrustN as number, electricalCapacityWh: capacity as number, energyUsedWh: capacity as number - remaining })
    control.scheduleBrake(c.nowMs + waitMs)
    const prediction: VehicleVtolBackCapturePrediction = { role, waitMs, windMps: [...predictedWind], status: 'expired', reason: 'forecast-hover-deadline', rotaryAtMs: null, rotaryPositionM: null, confirmedAtMs: null, requiredWh: null }
    report.predictions.push(prediction)
    let state = model.snapshot(), actuators = Array(8).fill(0), measurement = structuredClone(m), measurementPose = structuredClone(pose)
    const history = new Map<number, typeof state>([[c.nowMs, state]])
    let sequence = m.sequence
    for (let elapsed = 0; elapsed <= horizonMs; elapsed += 4) {
      const now = c.nowMs + elapsed
      if (elapsed > 0) state = model.step(actuators, 0.004, { windMps: predictedWind, currentMps: [0, 0, 0] })
      if (elapsed % 20 !== 0) continue
      history.set(now, state)
      const captured = history.get(now - 60)
      if (captured) {
        const relative = rotateNedToBody(captured.quaternionWxyz, captured.velocityMps.map((n, i) => n - predictedWind[i]!) as SensorVector)
        const speed = Math.hypot(...relative)
        measurement = { version: 1, vehicle: 'vtol', evidence: 'modeled-vehicle-sensors', reference: request.reference, sequence: ++sequence, capturedAtMs: now - 60, receivedAtMs: now,
          values: { onSurface: captured.onSurface, stopped: Math.hypot(...captured.velocityMps) <= 0.2, airspeedMps: speed, differentialPressurePa: 0.5 * vtolModel.wing.densityKgM3 * speed ** 2, alphaRad: Math.atan2(relative[2], relative[0]), betaRad: Math.atan2(relative[1], Math.hypot(relative[0], relative[2])), rotorThrustN: captured.details.rotorThrustN as number, pusherThrustN: captured.details.pusherThrustN as number, ...renderVtolElectricalMeasurement(captured) } }
        measurementPose = { capturedAtMs: now - 60, reference: request.reference, positionM: [...captured.positionM], velocityMps: [...captured.velocityMps], covarianceBlocks: structuredClone(cov), quaternionWxyz: [...captured.quaternionWxyz], positionCapturedAtMs: now - 60, positionPredictedToMs: now - 60, attitudeCapturedAtMs: now - 60, attitudePredictedToMs: now - 60, gyroCapturedAtMs: now - 60, attitudePrediction: 'qualified-gyro-hold' }
      }
      const previous = history.get(now - 20) ?? state
      const estimate = structuredClone(c.estimate)
      estimate.nowMs = now
      estimate.localPosition = { ...estimate.localPosition!, positionM: [...state.positionM], velocityMps: [...state.velocityMps], capturedAtMs: now, predictedToMs: now }
      estimate.attitude = { ...estimate.attitude!, quaternionWxyz: [...previous.quaternionWxyz], capturedAtMs: now - 20 }
      const context: VehicleControllerContext = { ...c, nowMs: now, estimate, measurement, measurementPose, controlRate: { evidence: 'modeled-qualified-imu', reference: request.reference, capturedAtMs: now - 20, angularRateRadS: [...previous.angularRateRadS] }, mission: { ...c.mission, elapsedMs: c.mission.elapsedMs + elapsed } }
      let output
      try { output = control.step(context) }
      catch { prediction.status = 'blocked'; prediction.reason = 'forecast-model-diverged'; break }
      actuators = output.actuators
      if (Math.hypot(state.positionM[0], state.positionM[1]) > policy.fence.radiusM || state.positionM[2] < policy.fence.minDownM || state.positionM[2] > policy.fence.maxDownM || state.onSurface || state.details.batteryCutoff) { prediction.status = 'blocked'; prediction.reason = 'forecast-state-envelope'; break }
      if (output.inhibited) { prediction.status = 'blocked'; prediction.reason = output.reason; break }
      if (prediction.rotaryAtMs === null && control.rotaryCaptured()) { prediction.rotaryAtMs = now; prediction.rotaryPositionM = [...state.positionM] }
      if (output.transition?.outcome === 'confirmed') {
        prediction.requiredWh = policy.power.maxW * (elapsed + policy.remainingMissionMs) / 3600000
        prediction.status = remaining - prediction.requiredWh >= reserveWh ? 'confirmed' : 'blocked'
        prediction.reason = prediction.status === 'confirmed' ? 'forecast-hover-confirmed' : 'forecast-reserve-exhausted'
        prediction.confirmedAtMs = now
        break
      }
      for (const at of history.keys()) if (at < now - 60) history.delete(at)
    }
    return prediction
  }
  try {
    const samples: SensorVector[] = [[...wind]]
    for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) { const sample = [...wind] as SensorVector; sample[axis] = sample[axis]! + sign * radius; samples.push(sample) }
    const probes = samples.map(sample => run(0, sample, 'probe'))
    if (probes.some(probe => !probe.rotaryPositionM)) { report.status = 'limit'; report.reason = 'forecast-braking-unavailable'; return report }
    const speed = Math.hypot(initial.velocityMps[0], initial.velocityMps[1])
    if (speed < 3) { report.reason = 'forecast-approach-speed-unqualified'; return report }
    const direction = [initial.velocityMps[0] / speed, initial.velocityMps[1] / speed]
    const seeds = probes.map(probe => {
      const remainingDistance = direction[0]! * (request.positionM[0] - probe.rotaryPositionM![0]) + direction[1]! * (request.positionM[1] - probe.rotaryPositionM![1])
      return Math.max(0, Math.min(vtolBackCaptureModel.maximumWaitMs, Math.round(remainingDistance / speed * 1000 / 20) * 20))
    })
    const seed = Math.min(...seeds)
    const waits = [...new Set([0, Math.max(0, seed - 1000), seed, Math.min(vtolBackCaptureModel.maximumWaitMs, seed + 1000)])]
    const candidates = waits.map(wait => ({ waitMs: wait, outcomes: wait === 0 ? probes : samples.map(sample => run(wait, sample, 'candidate')) }))
      .filter(candidate => candidate.outcomes.every(item => item.status === 'confirmed' && item.rotaryPositionM))
    candidates.sort((a, b) => Math.max(...a.outcomes.map(item => item.confirmedAtMs!)) - Math.max(...b.outcomes.map(item => item.confirmedAtMs!)))
    const selected = candidates[0]
    if (!selected) { report.status = 'limit'; report.reason = 'forecast-anchor-deadline-reserve-or-uncertainty'; return report }
    report.status = 'predicted'; report.reason = 'declared-forecast-scenarios-complete'; report.waitMs = selected.waitMs; report.brakeAtMs = c.nowMs + selected.waitMs
    return report
  }
  catch { report.reason = 'forecast-model-unavailable'; return report }
}
