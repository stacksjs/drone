import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { SurveyCamera, SurveyShutterCommand, SurveyShutterAck } from '../mapping/camera'
import type { AgricultureBandCalibration, AgricultureCapture, AgricultureImage, AgriculturePlan, AgricultureScenario } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'
import { intersectSurveyRay } from '../mapping/geometry'
import { volumeInsideRing } from '../volumes/geometry'
import { createModeledShutter } from '../payloads/modeled-shutter'
import { calibrateAgricultureImage } from './radiometry'

function snapshotImage(image: AgricultureImage): AgricultureImage {
  const { width, height } = image
  const shared = (array: Uint8Array | Uint16Array) => typeof SharedArrayBuffer !== 'undefined' && array.buffer instanceof SharedArrayBuffer
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16 || width * height > 65536 || !(image.rgba instanceof Uint8Array) || image.rgba.length !== width * height * 4 || !Array.isArray(image.bands) || image.bands.length !== 2 || image.bands.some((band, i) => band.band !== (i === 0 ? 'red' : 'nir') || !(band.counts instanceof Uint16Array) || band.counts.length !== width * height || shared(band.counts)) || shared(image.rgba)) throw new RangeError('Invalid agriculture shutter raster')
  return { width, height, rgba: new Uint8Array(image.rgba), registrationId: image.registrationId, registrationErrorPx: image.registrationErrorPx, bands: image.bands.map(band => ({ ...band, irradiance: { ...band.irradiance }, counts: new Uint16Array(band.counts) })) as AgricultureImage['bands'] }
}
/** Inverse of the declared radiance equation, evaluated at each raw sensor coordinate. */
function sceneDn(band: AgricultureBandCalibration, radiance: number, x: number, y: number, exposureTimeUs: number, gain: number): number {
  const exposure = exposureTimeUs / 1e6, [a1, a2, a3] = band.coefficients
  const radius = Math.hypot(x - band.vignetteCenterPx[0], y - band.vignetteCenterPx[1])
  const vignette = 1 + band.vignettePolynomial.reduce((sum, coefficient, i) => sum + coefficient * radius ** (i + 1), 0)
  const row = 1 + a2 * y / exposure - a3 * y
  const dn = band.blackLevelDn + radiance * gain * exposure * 65536 * vignette * row / a1
  if (!Number.isFinite(dn) || dn < 0 || dn > 65535) throw new RangeError('Agriculture modeled radiance outside sensor range')
  return Math.round(dn)
}
/** Truth is used only here to produce independent raw numeric bands and the visible scene. */
export function renderAgricultureImage(plan: AgriculturePlan, body: RigidBodyState, nowMs: number, scenario: AgricultureScenario = 'nominal'): AgricultureImage {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('Invalid agriculture image clock')
  const config = plan.config, survey = plan.survey.config, { width, height } = survey.calibration.output
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16 || width * height > 65536) throw new RangeError('Invalid agriculture image dimensions')
  const camera = createCalibratedCamera(survey.calibration, survey.heldOut)
  const lever = rotateBodyToNed(body.quaternionWxyz, camera.originBodyM)
  const origin = body.positionM.map((n, i) => n + lever[i]!) as SensorVector
  const illumination = [1 + .2 * Math.sin(nowMs / 3000), .9 + .15 * Math.cos(nowMs / 3700)]
  const fault = nowMs >= 10000 && nowMs < 12000
  const bands = config.radiometry.bands.map((band, i) => ({ band: band.name, capturedAtMs: nowMs + (fault && scenario === 'band-skew' && i === 1 ? config.radiometry.maxSyncMs + 1 : 0), exposureTimeUs: survey.exposureTimeUs, gain: 1, irradiance: { capturedAtMs: fault && scenario === 'irradiance-loss' ? nowMs - config.radiometry.maxIrradianceAgeMs - 1 : nowMs, valueWm2Nm: illumination[i]! }, counts: new Uint16Array(width * height) })) as AgricultureImage['bands']
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ray = rotateBodyToNed(body.quaternionWxyz, camera.bodyRay([x + .5, y + .5]))
    const hit = intersectSurveyRay(survey, origin, ray), point: [number, number] = [hit[0], hit[1]]
    const field = volumeInsideRing(point, survey.boundary) && !survey.holes.some(hole => volumeInsideRing(point, hole))
    const lightAnimal = field && ((hit[0] + .35) / .13) ** 2 + ((hit[1] + .3) / .075) ** 2 < 1
    const darkAnimal = field && ((hit[0] - .35) / .12) ** 2 + ((hit[1] - .3) / .07) ** 2 < 1
    const reflectance = lightAnimal ? [.35, .4] : darkAnimal ? [.06, .08] : !field ? [.15, .18] : hit[0] < 0 ? [.1, .7] : hit[1] < 0 ? [.2, .4] : [.25, .15]
    const index = y * width + x
    for (let i = 0; i < 2; i++) bands[i]!.counts[index] = fault && scenario === 'saturation' ? 65535 : sceneDn(config.radiometry.bands[i]!, reflectance[i]! * illumination[i]! / Math.PI, x, y, survey.exposureTimeUs, 1)
    // Independent visible landmarks, not an index palette or automatic animal labels.
    const colour = lightAnimal ? [235, 230, 211] : darkAnimal ? [48, 42, 36] : !field ? [126, 96, 68] : hit[0] < 0 ? [58, 112, 50] : hit[1] < 0 ? [112, 130, 59] : [149, 118, 65]
    rgba.set([...colour, 255], index * 4)
  }
  return { width, height, rgba, registrationId: 'synthetic-common-optical-grid-v1', registrationErrorPx: 0, bands }
}

/** One whole raw multi-band ACK is admitted before its visible survey projection becomes available. */
export function createAgricultureCamera(plan: AgriculturePlan, scenario: AgricultureScenario = 'nominal'): SurveyCamera & { captures: () => AgricultureCapture[], failure: () => string | null } {
  const shutter = createModeledShutter((body, nowMs) => renderAgricultureImage(plan, body, nowMs, scenario), snapshotImage, { fault: scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none', faultAfterMs: 10000 })
  let pending: SurveyShutterCommand | null = null, reason: string | null = null
  const retained: AgricultureCapture[] = []
  function fail(message: string): never { reason ??= message; pending = null; shutter.close(); throw new RangeError(message) }
  return {
    render: shutter.render,
    request(command) {
      if (reason || pending) fail('agriculture-camera-request-uncertain')
      if (retained.length >= 64) fail('agriculture-capture-capacity')
      try { shutter.request(command); pending = { ...command } }
      catch { fail('agriculture-camera-request-failed') }
    },
    poll(nowMs): SurveyShutterAck | null {
      if (reason) fail(reason)
      const ack = shutter.poll(nowMs)
      if (!ack) {
        if (pending && nowMs >= pending.issuedAtMs + 80) fail('agriculture-camera-ack-deadline')
        return null
      }
      if (!pending || ack.sessionId !== pending.sessionId || ack.sequence !== pending.sequence || ack.reference !== pending.reference || ack.issuedAtMs !== pending.issuedAtMs || ack.capturedAtMs !== pending.issuedAtMs || ack.acknowledgedAtMs <= pending.issuedAtMs || ack.acknowledgedAtMs > pending.issuedAtMs + 80 || ack.acknowledgedAtMs > nowMs) fail('agriculture-camera-ack-scope-or-timing')
      let calibrated
      try { calibrated = calibrateAgricultureImage(plan.config.radiometry, ack.image, ack.capturedAtMs) }
      catch {
        const image = ack.image
        if (image.bands.some(band => band.irradiance.capturedAtMs > ack.capturedAtMs || ack.capturedAtMs - band.irradiance.capturedAtMs > plan.config.radiometry.maxIrradianceAgeMs || !Number.isFinite(band.irradiance.valueWm2Nm) || band.irradiance.valueWm2Nm <= 0)) fail('agriculture-irradiance-unqualified')
        if (image.bands.some(band => Math.abs(band.capturedAtMs - ack.capturedAtMs) > plan.config.radiometry.maxSyncMs)) fail('agriculture-band-synchronization')
        fail('agriculture-radiometry-unqualified')
      }
      if (!calibrated.qualified) fail('agriculture-insufficient-valid-pixels')
      if (ack.image.width !== plan.survey.config.calibration.output.width || ack.image.height !== plan.survey.config.calibration.output.height) fail('agriculture-camera-image-grid')
      retained.push({ captureId: `photo-${String(ack.sequence).padStart(4, '0')}`, sessionId: ack.sessionId, sequence: ack.sequence, reference: ack.reference, issuedAtMs: ack.issuedAtMs, capturedAtMs: ack.capturedAtMs, acknowledgedAtMs: ack.acknowledgedAtMs, image: snapshotImage(ack.image) })
      pending = null
      return { sessionId: ack.sessionId, sequence: ack.sequence, reference: ack.reference, issuedAtMs: ack.issuedAtMs, capturedAtMs: ack.capturedAtMs, acknowledgedAtMs: ack.acknowledgedAtMs, rgba: new Uint8Array(ack.image.rgba) }
    },
    close() { pending = null; shutter.close() },
    captures: () => retained.map(capture => ({ ...capture, image: snapshotImage(capture.image) })),
    failure: () => reason,
  }
}
