import type { ApplicationConfig } from './types'
import type { ApplicationControllerInput, ApplicationDecision, ApplicationGrant, ApplicationMeterFeedback } from './runtime-types'
import { applicationPulseFactor, applicationScaleFactor } from './calibration'
import { volumeIntersectConvex, volumeSignedArea, volumeTriangulateRing } from '../volumes/geometry'
import type { VolumeXY } from '../volumes/types'

/** Deterministic host policy. Inputs are qualified estimated ground navigation and independent quantized instruments, never plant truth. */
export function createApplicationController(config: ApplicationConfig, options: { visitId: string, authorizeImplement: boolean, testMode: boolean }) {
  const triangles = volumeTriangulateRing(config.boundary), excluded = config.exclusions.flatMap(volumeTriangulateRing)
  const zones = config.prescription.map(zone => ({ ...zone, triangles: volumeTriangulateRing(zone.polygon) }))
  const pulseK = config.calibration.pulse ? applicationPulseFactor(config.calibration.pulse) : null, scaleK = applicationScaleFactor(config.calibration.scale)
  const quantum = pulseK ? 1 / pulseK : 1 / scaleK, countMax = config.calibration.encoderCounts
  let lastAt = -1, grantSequence = 0, lease: ApplicationGrant | null = null, reference: string | null = null
  let latch: string | null = null, wasApplying = false, previousTarget = 0, previousPrimary = 0, previousMaster = 0
  let prior: ApplicationMeterFeedback | null = null, signature = '', delivered = 0, lastDeliveryAt = 0, demandedSince: number | null = null, mismatchSince: number | null = null, closedSince: number | null = null
  const history: { atMs: number, delivered: number }[] = []
  const amount = (raw: number) => (raw - config.calibration.scale.tareRaw) / scaleK / (config.material.unit === 'L' ? config.material.densityKgPerL! : 1)
  const clippedArea = (polygon: VolumeXY[], source: VolumeXY[][]) => source.reduce((sum, triangle) => sum + Math.abs(volumeSignedArea(volumeIntersectConvex(polygon, triangle))), 0)
  function forecast(input: ApplicationControllerInput): VolumeXY[] {
    const o = input.ground, lag = (config.calibration.primaryCloseMs + config.calibration.masterCloseMs + 240) / 1000 + config.implement.fallTimeS
    const ahead = Math.max(0, o.speedMps) * lag, grow = o.uncertaintyM
    const length = config.implement.footprintLengthM + 2 * grow + ahead, width = config.implement.swathM + 2 * grow
    const c = Math.cos(o.yawRad), s = Math.sin(o.yawRad), n = o.positionM[0] + ahead * c / 2 + input.weather.windMps[0] * config.implement.fallTimeS, e = o.positionM[1] + ahead * s / 2 + input.weather.windMps[1] * config.implement.fallTimeS
    return ([[-length / 2, -width / 2], [length / 2, -width / 2], [length / 2, width / 2], [-length / 2, width / 2]] as VolumeXY[]).map(([a, b]) => [n + a * c - b * s, e + a * s + b * c])
  }
  function readFeedback(input: ApplicationControllerInput): { rate: number | null, remaining: number | null } {
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
  return { step(input: ApplicationControllerInput): ApplicationDecision {
    const i = input, o = i.ground
    if (!Number.isSafeInteger(i.atMs) || i.atMs < 0 || i.atMs <= lastAt || i.atMs > 185000) throw new RangeError('Application controller clock must strictly increase')
    if (lastAt >= 0 && i.atMs - lastAt > 40 && wasApplying) latch ??= 'application-host-gap'
    lastAt = i.atMs
    if (reference !== null && reference !== i.reference) latch ??= 'application-reference-changed'
    reference = i.reference
    const feedback = readFeedback(i)
    if (i.grant) {
      const g = i.grant
      if (!Number.isSafeInteger(g.sequence) || g.sequence !== grantSequence + 1 || g.issuedAtMs !== i.atMs || !Number.isSafeInteger(g.expiresAtMs) || g.expiresAtMs < i.atMs || g.expiresAtMs > i.atMs + 500 || g.visitId !== options.visitId || g.configId !== config.id || g.materialId !== config.material.id || g.reference !== i.reference || !['grant', 'renew', 'revoke'].includes(g.action) || g.action === 'renew' && lease === null) latch ??= 'application-grant-invalid'
      else { grantSequence = g.sequence; lease = g.action === 'revoke' ? null : { ...g }; if (g.action === 'revoke' && wasApplying) latch ??= 'application-grant-revoked' }
    }
    if (wasApplying && lease && i.atMs >= lease.expiresAtMs) latch ??= 'application-grant-expired'
    if (wasApplying && !i.enabled) latch ??= 'application-vehicle-authority-lost'
    if (i.emergency) latch ??= 'application-emergency-stop'
    if (i.enabled && !o.healthy) latch ??= o.reason
    if (i.enabled && (!o.guardClosed || o.emergency || !o.onSurface || o.personM <= 2 || o.obstacleM <= 1)) latch ??= 'application-safety-interlock'
    if (i.atMs - i.weather.capturedAtMs > config.weatherLimits.maxAgeMs || i.weather.capturedAtMs > i.atMs || ![...i.weather.windMps, i.weather.temperatureC, i.weather.humidityPercent].every(Number.isFinite) || Math.hypot(...i.weather.windMps) > config.weatherLimits.maxWindMps || i.weather.temperatureC < config.weatherLimits.minTemperatureC || i.weather.temperatureC > config.weatherLimits.maxTemperatureC || i.weather.humidityPercent < config.weatherLimits.minHumidityPercent || i.weather.inversion) latch ??= 'application-weather-unqualified'
    if (previousTarget > 0 && feedback.remaining !== null && feedback.remaining <= quantum * 2) latch ??= 'application-level-empty'
    if (previousTarget > 0 && demandedSince !== null && i.atMs - demandedSince > config.calibration.noFlowTimeoutMs && i.atMs - lastDeliveryAt > config.calibration.noFlowTimeoutMs) latch ??= 'application-inadequate-delivery'
    if (prior && (Math.abs(prior.primaryEncoder / countMax - previousPrimary) > .06 || Math.abs(prior.masterEncoder / countMax - previousMaster) > .06)) mismatchSince ??= i.atMs
    else mismatchSince = null
    if (mismatchSince !== null && i.atMs - mismatchSince > Math.max(config.calibration.primaryCloseMs, config.calibration.masterCloseMs) + 140) latch ??= 'application-barrier-position-disagreement'
    if (closedSince !== null && i.atMs - closedSince > config.calibration.closingAllowanceMs && feedback.rate !== null && feedback.rate > Math.max(quantum / .4, config.calibration.minRatePerSecond / 2)) latch ??= 'application-unexpected-flow-after-close'
    let state: ApplicationDecision['state'] = 'standby', reason = 'application-outside-apply-task', target = 0, zoneId: string | null = null
    if (options.testMode || !options.authorizeImplement) { state = 'dry'; reason = options.testMode ? 'application-test-mode' : 'application-no-explicit-grant' }
    else if (!latch && i.enabled && lease && i.atMs < lease.expiresAtMs && i.missionState === 'running' && i.taskId.startsWith('apply-')) {
      if (o.speedMps < config.implement.minSpeedMps || o.speedMps > config.implement.maxSpeedMps || Math.abs(o.yawRateRadS) > .25) reason = 'application-speed-or-turning-inhibit'
      else {
        const footprint = forecast(i), area = Math.abs(volumeSignedArea(footprint)), tolerance = Math.max(1e-8, area * 1e-8)
        const zone = zones.find(z => Math.abs(clippedArea(footprint, z.triangles) - area) <= tolerance)
        if (Math.abs(clippedArea(footprint, triangles) - area) > tolerance || clippedArea(footprint, excluded) > tolerance) reason = 'application-footprint-guard'
        else if (!zone) reason = 'application-no-whole-footprint-prescription'
        else {
          target = zone.ratePerHa * o.speedMps * config.implement.swathM / 10000; zoneId = zone.id
          if (target < config.calibration.minRatePerSecond || target > config.calibration.maxRatePerSecond) { latch ??= 'application-rate-unattainable'; target = 0 }
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
    return { atMs: i.atMs, state, reason, taskId: i.taskId, prescriptionId: zoneId, targetPerSecond: target, measuredPerSecond: feedback.rate, measuredDeliveredAmount: delivered, measurementUncertainty: 2 * quantum, estimatedPositionM: [...o.positionM], grantExpiresAtMs: lease?.expiresAtMs ?? null, channels, stopVehicle: latch !== null }
  } }
}
