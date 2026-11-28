import type { ApplicationConfig } from './types'
import type { ApplicationDecision, ApplicationGrant, ApplicationHostInput, ApplicationMeterFeedback } from './runtime-types'
import { applicationPulseFactor, applicationScaleFactor } from './calibration'
import { validateApplicationConfig } from './planner'
import { volumeIntersectConvex, volumeSignedArea, volumeTriangulateRing } from '../volumes/geometry'
import type { VolumeXY } from '../volumes/types'

/** Deterministic host policy over qualified estimated motion and independent quantized instruments. */
export function createApplicationController(configInput: ApplicationConfig, inputOptions: { visitId: string, authorizeImplement: boolean, testMode: boolean }, operatingHeightM?: number) {
  const config = validateApplicationConfig(configInput)
  if (!inputOptions || typeof inputOptions !== 'object' || ['visitId', 'authorizeImplement', 'testMode'].some(key => !Object.hasOwn(inputOptions, key) || !('value' in Object.getOwnPropertyDescriptor(inputOptions, key)!))) throw new TypeError('Invalid application controller options')
  const options = { visitId: inputOptions.visitId, authorizeImplement: inputOptions.authorizeImplement, testMode: inputOptions.testMode }
  if (typeof options.visitId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(options.visitId) || typeof options.authorizeImplement !== 'boolean' || typeof options.testMode !== 'boolean') throw new TypeError('Invalid application controller options')
  if (operatingHeightM !== undefined && (!Number.isFinite(operatingHeightM) || operatingHeightM < .8 || operatingHeightM > 3 || config.material.kind !== 'water')) throw new TypeError('Invalid aerial application policy')
  const triangles = volumeTriangulateRing(config.boundary), excluded = config.exclusions.flatMap(volumeTriangulateRing)
  const zones = config.prescription.map(zone => ({ ...zone, triangles: volumeTriangulateRing(zone.polygon) }))
  const pulseK = config.calibration.pulse ? applicationPulseFactor(config.calibration.pulse) : null, scaleK = applicationScaleFactor(config.calibration.scale)
  const quantum = pulseK ? 1 / pulseK : 1 / scaleK, countMax = config.calibration.encoderCounts
  let lastAt = -1, grantSequence = 0, lease: ApplicationGrant | null = null, reference: string | null = null
  let latch: string | null = null, wasApplying = false, previousTarget = 0, previousPrimary = 0, previousMaster = 0
  let prior: ApplicationMeterFeedback | null = null, signature = '', delivered = 0, lastDeliveryAt = 0, demandedSince: number | null = null, mismatchSince: number | null = null, closedSince: number | null = null
  const history: { atMs: number, delivered: number }[] = []
  const valveCommands = [{ atMs: -1, primary: 0, master: 0 }]
  let lastPosition: [number, number, number] = [0, 0, 0]
  const amount = (raw: number) => (raw - config.calibration.scale.tareRaw) / scaleK / (config.material.unit === 'L' ? config.material.densityKgPerL! : 1)
  const clippedArea = (polygon: VolumeXY[], source: VolumeXY[][]) => source.reduce((sum, triangle) => sum + Math.abs(volumeSignedArea(volumeIntersectConvex(polygon, triangle))), 0)
  const settlingMs = Math.max(config.calibration.primaryCloseMs, config.calibration.masterCloseMs)
  function aerialBarrierDisagrees(sample: ApplicationMeterFeedback) {
    const since = sample.capturedAtMs - settlingMs - 40
    while (valveCommands.length > 1 && valveCommands[1]!.atMs <= since) valveCommands.shift()
    // Compare delayed feedback with the range of commands that could still affect this capture.
    let primaryMin = 1, primaryMax = 0, masterMin = 1, masterMax = 0
    for (const issued of valveCommands) {
      if (issued.atMs >= sample.capturedAtMs) break
      primaryMin = Math.min(primaryMin, issued.primary)
      primaryMax = Math.max(primaryMax, issued.primary)
      masterMin = Math.min(masterMin, issued.master)
      masterMax = Math.max(masterMax, issued.master)
    }
    const primary = sample.primaryEncoder / countMax, master = sample.masterEncoder / countMax
    return primary < primaryMin - .06 || primary > primaryMax + .06 || master < masterMin - .06 || master > masterMax + .06
  }
  function forecast(input: ApplicationHostInput): VolumeXY[] {
    const o = 'flight' in input ? input.flight : input.ground
    const lag = (config.calibration.primaryCloseMs + config.calibration.masterCloseMs + 240) / 1000
    const fall = config.implement.fallTimeS, c = Math.cos(o.yawRad), s = Math.sin(o.yawRad)
    let n = o.positionM[0] + input.weather.windMps[0] * fall
    let e = o.positionM[1] + input.weather.windMps[1] * fall
    let along: number, cross = 0
    if ('flight' in input) {
      const [vn, ve] = input.flight.velocityMps
      along = (vn * c + ve * s) * lag
      cross = (-vn * s + ve * c) * lag
      n += vn * fall
      e += ve * fall
    }
    else along = Math.max(0, input.ground.speedMps) * (lag + fall)
    n += (along * c - cross * s) / 2
    e += (along * s + cross * c) / 2
    const length = config.implement.footprintLengthM + 2 * o.uncertaintyM + Math.abs(along)
    const width = config.implement.swathM + 2 * o.uncertaintyM + Math.abs(cross)
    return ([[-length / 2, -width / 2], [length / 2, -width / 2], [length / 2, width / 2], [-length / 2, width / 2]] as VolumeXY[]).map(([a, b]) => [n + a * c - b * s, e + a * s + b * c])
  }
  function readFeedback(input: ApplicationHostInput): { rate: number | null, remaining: number | null } {
    const f = input.feedback
    if (!f || !Number.isSafeInteger(f.sequence) || f.sequence < 1 || !Number.isSafeInteger(f.capturedAtMs) || f.capturedAtMs < 0 || f.capturedAtMs > input.atMs || input.atMs - f.capturedAtMs > 140 || ![f.pulseCount, f.scaleRaw, f.primaryEncoder, f.masterEncoder, f.energyEncoder].every(Number.isSafeInteger) || f.pulseCount < 0 || f.scaleRaw < config.calibration.scale.tareRaw || [f.primaryEncoder, f.masterEncoder, f.energyEncoder].some(n => n < 0 || n > countMax)) { latch ??= 'application-meter-unavailable'; return { rate: null, remaining: null } }
    const encoded = JSON.stringify(f)
    if (prior && (f.sequence < prior.sequence || f.capturedAtMs < prior.capturedAtMs || f.sequence === prior.sequence && signature !== encoded || f.sequence > prior.sequence && f.capturedAtMs <= prior.capturedAtMs || f.pulseCount < prior.pulseCount)) { latch ??= 'application-meter-replay'; return { rate: null, remaining: null } }
    const remaining = amount(f.scaleRaw)
    if (prior && f.sequence > prior.sequence) {
      const delta = pulseK ? (f.pulseCount - prior.pulseCount) / pulseK : Math.max(0, amount(prior.scaleRaw) - remaining)
      const physicalMaximum = config.calibration.maxRatePerSecond * (f.capturedAtMs - prior.capturedAtMs) / 1000 + 2 * quantum
      if (delta > physicalMaximum) {
        if (remaining > quantum * 2) latch ??= 'application-meter-inconsistent'
      }
      else { delivered += delta; if (delta > quantum / 2) lastDeliveryAt = input.atMs }
    }
    prior = { ...f }; signature = encoded
    history.push({ atMs: f.capturedAtMs, delivered })
    while (history.length > 1 && history[1]!.atMs <= f.capturedAtMs - 400) history.shift()
    const first = history[0]!, elapsed = (f.capturedAtMs - first.atMs) / 1000
    const rate = elapsed > 0 ? (delivered - first.delivered) / elapsed : null
    return { rate, remaining }
  }
  return { step(input: ApplicationHostInput): ApplicationDecision {
    const i = input, flight = 'flight' in i ? i.flight : null, ground = 'ground' in i ? i.ground : null
    if ((operatingHeightM !== undefined) !== (flight !== null) || !!flight === !!ground) throw new TypeError('Application motion source does not match the declared carrier')
    const o = (flight ?? ground)!
    const velocity = flight && Array.isArray(flight.velocityMps) && flight.velocityMps.length === 3
      && [flight.velocityMps[0], flight.velocityMps[1], flight.velocityMps[2]].every(Number.isFinite) ? flight.velocityMps : null
    const speed = flight ? velocity ? Math.hypot(velocity[0], velocity[1]) : NaN : ground!.speedMps
    if (!Number.isSafeInteger(i.atMs) || i.atMs < 0 || i.atMs <= lastAt || i.atMs > 185000) throw new RangeError('Application controller clock must strictly increase')
    if (lastAt >= 0 && i.atMs - lastAt > 40 && wasApplying) latch ??= 'application-host-gap'
    lastAt = i.atMs
    const positionValid = Array.isArray(o.positionM) && o.positionM.length === 3 && o.positionM.every(n => Number.isFinite(n) && Math.abs(n) <= 100000)
    if (positionValid) lastPosition = [...o.positionM]
    const motionValid = positionValid && [speed, o.yawRad, o.yawRateRadS, o.uncertaintyM].every(Number.isFinite) && o.uncertaintyM > 0 && o.uncertaintyM <= 1 && Math.abs(o.yawRateRadS) <= 10 && [o.healthy, o.onSurface, o.guardClosed].every(n => typeof n === 'boolean')
    if (flight) {
      if (!motionValid || !velocity || speed > 8 || !Number.isFinite(flight.tiltRad) || flight.tiltRad < 0 || !Number.isFinite(flight.verticalUncertaintyM) || flight.verticalUncertaintyM <= 0 || flight.verticalUncertaintyM > 1) latch ??= 'application-flight-unqualified'
    }
    else if (!motionValid || !ground || ![ground.wheelSpeedMps, ground.personM, ground.obstacleM].every(Number.isFinite) || ground.personM < 0 || ground.obstacleM < 0 || Math.abs(speed) > 2 || Math.abs(ground.wheelSpeedMps) > 5 || typeof ground.stopped !== 'boolean' || typeof ground.emergency !== 'boolean') latch ??= 'application-ground-unqualified'
    if (reference !== null && reference !== i.reference) latch ??= 'application-reference-changed'
    reference = i.reference
    const feedback = readFeedback(i)
    // Expiry is checked against the previous lease before accepting a renewal.
    if (wasApplying && lease && i.atMs >= lease.expiresAtMs) latch ??= 'application-grant-expired'
    if (i.grant) {
      const g = i.grant
      if (!Number.isSafeInteger(g.sequence) || g.sequence !== grantSequence + 1 || g.issuedAtMs !== i.atMs || !Number.isSafeInteger(g.expiresAtMs) || g.expiresAtMs < i.atMs || g.expiresAtMs > i.atMs + 500 || g.visitId !== options.visitId || g.configId !== config.id || g.materialId !== config.material.id || g.reference !== i.reference || !['grant', 'renew', 'revoke'].includes(g.action) || g.action === 'renew' && lease === null) latch ??= 'application-grant-invalid'
      else { grantSequence = g.sequence; lease = g.action === 'revoke' ? null : { ...g }; if (g.action === 'revoke' && wasApplying && i.missionState !== 'completed') latch ??= 'application-grant-revoked' }
    }
    if (wasApplying && !i.enabled && i.missionState !== 'completed') latch ??= 'application-vehicle-authority-lost'
    if (i.emergency) latch ??= 'application-emergency-stop'
    if (i.enabled && !o.healthy) latch ??= o.reason
    if (i.enabled && (!o.guardClosed || ground && (ground.emergency || !ground.onSurface || ground.personM <= 2 || ground.obstacleM <= 1))) latch ??= 'application-safety-interlock'
    if (!Number.isSafeInteger(i.weather.capturedAtMs) || i.weather.capturedAtMs < 0 || i.atMs - i.weather.capturedAtMs > config.weatherLimits.maxAgeMs || i.weather.capturedAtMs > i.atMs || !Array.isArray(i.weather.windMps) || i.weather.windMps.length !== 2 || ![...i.weather.windMps, i.weather.temperatureC, i.weather.humidityPercent].every(Number.isFinite) || Math.hypot(...i.weather.windMps) > config.weatherLimits.maxWindMps || i.weather.temperatureC < config.weatherLimits.minTemperatureC || i.weather.temperatureC > config.weatherLimits.maxTemperatureC || i.weather.humidityPercent < config.weatherLimits.minHumidityPercent || i.weather.humidityPercent > 100 || typeof i.weather.inversion !== 'boolean' || i.weather.inversion) latch ??= 'application-weather-unqualified'
    if (previousTarget > 0 && feedback.remaining !== null && feedback.remaining <= quantum * 2) latch ??= 'application-level-empty'
    if (previousTarget > 0 && demandedSince !== null && i.atMs - demandedSince > config.calibration.noFlowTimeoutMs && i.atMs - lastDeliveryAt > config.calibration.noFlowTimeoutMs) latch ??= 'application-inadequate-delivery'
    if (prior && (flight ? aerialBarrierDisagrees(prior) : Math.abs(prior.primaryEncoder / countMax - previousPrimary) > .06 || Math.abs(prior.masterEncoder / countMax - previousMaster) > .06)) mismatchSince ??= i.atMs
    else mismatchSince = null
    if (mismatchSince !== null && i.atMs - mismatchSince > settlingMs + 140) latch ??= 'application-barrier-position-disagreement'
    if (closedSince !== null && i.atMs - closedSince > config.calibration.closingAllowanceMs && feedback.rate !== null && feedback.rate > Math.max(quantum / .4, config.calibration.minRatePerSecond / 2)) latch ??= 'application-unexpected-flow-after-close'
    let state: ApplicationDecision['state'] = 'standby', reason = 'application-outside-apply-task', target = 0, zoneId: string | null = null
    if (options.testMode || !options.authorizeImplement) { state = 'dry'; reason = options.testMode ? 'application-test-mode' : 'application-no-explicit-grant' }
    else if (!latch && i.enabled && lease && i.atMs < lease.expiresAtMs && i.missionState === 'running' && i.taskId.startsWith('apply-')) {
      const courseDot = velocity ? velocity[0] * Math.cos(o.yawRad) + velocity[1] * Math.sin(o.yawRad) : speed
      if (flight && (flight.onSurface || Math.abs(-flight.positionM[2] - operatingHeightM!) + flight.verticalUncertaintyM > .4 || Math.abs(flight.velocityMps[2]) > .25 || flight.tiltRad > .3)) reason = 'application-height-or-attitude-inhibit'
      else if (speed < config.implement.minSpeedMps || speed > config.implement.maxSpeedMps || Math.abs(o.yawRateRadS) > .25 || courseDot < .97 * speed) reason = 'application-speed-or-turning-inhibit'
      else {
        const footprint = forecast(i), area = Math.abs(volumeSignedArea(footprint)), tolerance = Math.max(1e-8, area * 1e-8)
        const zone = zones.find(z => Math.abs(clippedArea(footprint, z.triangles) - area) <= tolerance)
        if (Math.abs(clippedArea(footprint, triangles) - area) > tolerance || clippedArea(footprint, excluded) > tolerance) reason = 'application-footprint-guard'
        else if (!zone) reason = 'application-no-whole-footprint-prescription'
        else {
          target = zone.ratePerHa * speed * config.implement.swathM / 10000; zoneId = zone.id
          if (zone.ratePerHa === 0) reason = 'application-zero-prescription'
          else if (feedback.remaining !== null && feedback.remaining <= quantum * 2) { latch ??= 'application-level-empty'; target = 0 }
          else if (target < config.calibration.minRatePerSecond || target > config.calibration.maxRatePerSecond) { latch ??= 'application-rate-unattainable'; target = 0 }
          else { state = 'applying'; reason = 'application-qualified-rate-control'; wasApplying = true }
        }
      }
    }
    else if (!latch && (!lease || i.atMs >= lease.expiresAtMs)) reason = 'application-no-valid-implement-lease'
    if (latch) { state = 'latched'; reason = latch; target = 0 }
    const channels: [number, number, number] = target > 0 ? [target / config.calibration.maxRatePerSecond, 1, 1] : [0, 0, 0]
    if (target > 0 && previousTarget <= 0) { demandedSince = i.atMs; lastDeliveryAt = i.atMs; closedSince = null }
    if (target <= 0 && previousTarget > 0) { closedSince = i.atMs; demandedSince = null }
    previousTarget = target; previousPrimary = channels[0]; previousMaster = channels[1]
    if (flight) {
      const margin = settlingMs + 200
      while (valveCommands.length > 1 && valveCommands[1]!.atMs <= i.atMs - margin) valveCommands.shift()
      valveCommands.push({ atMs: i.atMs, primary: channels[0], master: channels[1] })
    }
    return { atMs: i.atMs, state, reason, taskId: i.taskId, prescriptionId: zoneId, targetPerSecond: target, measuredPerSecond: feedback.rate, measuredDeliveredAmount: delivered, measurementUncertainty: 2 * quantum, estimatedPositionM: [...lastPosition], grantExpiresAtMs: lease?.expiresAtMs ?? null, channels, stopVehicle: latch !== null && flight === null }
  } }
}
