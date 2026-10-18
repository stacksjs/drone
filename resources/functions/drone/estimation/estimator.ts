import type { SensorSnapshot } from '../sensors/pipeline'
import type { GnssMeasurement, ImuMeasurement, PressureMeasurement, SensorKind, SensorObservation, SensorVector } from '../sensors/types'
import type { GeodeticOrigin, Quaternion } from './frames'
import type { AxisState } from './position'
import { geodeticToEcef, geodeticToNed, nedRotation, multiplyQuaternion, normalizeQuaternion, quaternionEuler, quaternionFromTilt } from './frames'
import { correctAxis, predictAxis } from './position'

const gravity = 9.80665
const limits = { imu: 80, gnss: 1500, barometer: 300 }
const vector = (v: unknown): v is SensorVector => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) < 1e6)
const variance = (v: unknown): v is SensorVector => vector(v) && v.every(n => n > 0)
interface Source { sequence: number, capturedUs: bigint, deviceId: string, calibrationId: string | null, pressureHeight: (Omit<NonNullable<GnssEstimatorSnapshot['pressureHeight']>, 'varianceM2'> & { varianceM2: number | null }) | null }
/** Bench estimator, consuming qualified sensor snapshots. Never produces control Telemetry. */
export function createEstimator(options: { origin?: GeodeticOrigin, gravityCorrection?: 'norm-gated' | 'initialization-only' } = {}) {
  const gravityMode = options.gravityCorrection ?? 'norm-gated'
  if (!['norm-gated', 'initialization-only'].includes(gravityMode)) throw new TypeError('Invalid gravity correction mode')
  let origin = options.origin ? structuredClone(options.origin) : null
  if (origin) geodeticToEcef(origin)
  let boot: bigint | null = null, evidence: SensorSnapshot['evidence'] | null = null, now = -Infinity
  let q: Quaternion | null = null, lastImuMs: number | null = null, lastImuUs: bigint | null = null, imuExpires = -Infinity
  let window: { atUs: bigint, force: SensorVector }[] = []
  let axes: AxisState[] | null = null, gpsAtMs: number | null = null, gpsUs: bigint | null = null, gpsExpires = -Infinity, gpsFault = 'missing'
  let pressure0: number | null = null, pressureDown: number | null = null, pressureExpires = -Infinity
  let pressureAtMs: number | null = null
  const seen: Partial<Record<SensorKind, Source>> = {}
  const resets = { attitude: 0, position: 0, boot: 0, manual: 0, clock: 0 }
  const events: { atMs: number, reason: string }[] = []
  let imuFault = 'aligning', gravityCorrection = false
  function event(reason: string) { events.push({ atMs: now, reason }); if (events.length > 20) events.shift() }
  function resetTilt(reason: string) {
    if (q || window.length) { resets.attitude++; event(reason) }
    q = null; window = []; lastImuMs = null; lastImuUs = null; imuExpires = -Infinity; imuFault = reason
  }
  function clear(reason: string) {
    resetTilt(reason)
    if (axes) { resets.position++; event(reason) }
    axes = null; gpsAtMs = null; gpsUs = null; gpsExpires = -Infinity; gpsFault = reason
    pressure0 = null; pressureDown = null; pressureAtMs = null; pressureExpires = -Infinity
    for (const key of Object.keys(seen) as SensorKind[]) delete seen[key]
  }
  function clock(atMs: number) {
    if (!Number.isFinite(atMs) || atMs < now) {
      resets.clock++; clear('clock-discontinuity'); throw new RangeError('Estimator clock must be finite and monotonic')
    }
    now = atMs
  }
  function qualified(frame: SensorSnapshot, o: SensorObservation | null | undefined, kind: SensorKind): o is SensorObservation {
    return !!o && o.kind === kind && o.healthy && o.value !== null && Number.isInteger(o.sequence) && o.sequence > 0 && typeof o.capturedUs === 'bigint'
      && Number.isFinite(o.estimatedCaptureMs) && o.estimatedCaptureMs <= now && Number.isFinite(o.receivedAtMs) && o.receivedAtMs <= now
      && o.measurementAgeUpperMs !== null && Number.isFinite(o.measurementAgeUpperMs) && o.measurementAgeUpperMs >= Math.max(0, now - o.estimatedCaptureMs)
      && o.measurementAgeUpperMs <= limits[kind] && o.timeUncertaintyUs !== null && Number.isFinite(o.timeUncertaintyUs) && o.timeUncertaintyUs >= 0
      && !o.quality.some(flag => ['stream-overrun', 'timing-unvalidated', 'measurement-epoch-unaligned', 'stuck-suspected'].includes(flag))
      && !(frame.evidence === 'handshake' && o.quality.includes('calibration-fixture'))
  }
  function tilt(o: SensorObservation) {
    const value = o.value as ImuMeasurement
    if (value.frame !== 'BODY_FRD' || !vector(value.specificForceMps2) || !vector(value.angularRateRadS) || !variance(value.specificForceVariance) || !variance(value.angularRateVariance) || Math.hypot(...value.angularRateRadS) > 35) { resetTilt('invalid-imu'); return }
    const f = value.specificForceMps2, magnitude = Math.hypot(...f), at = o.estimatedCaptureMs
    const quiet = Math.abs(magnitude - gravity) < 0.05 * gravity && Math.hypot(...value.angularRateRadS) < 0.1
    const dt = lastImuUs === null ? 0 : Number(o.capturedUs - lastImuUs) / 1e6
    if (lastImuUs !== null && (dt <= 0 || dt > 0.05)) resetTilt('imu-gap-or-time-reversal')
    lastImuMs = at; lastImuUs = o.capturedUs
    if (!q) {
      if (!quiet || (window.length && Math.hypot(...f.map((n, i) => n - window[0]!.force[i]!)) > 0.1)) window = []
      if (quiet) window.push({ atUs: o.capturedUs, force: [...f] })
      if (window.length > 32) window.shift()
      if (window.length >= 20 && o.capturedUs - window[0]!.atUs >= 380000n) {
        const mean = [0, 1, 2].map(i => window.reduce((sum, row) => sum + row.force[i]!, 0) / window.length)
        q = quaternionFromTilt(Math.atan2(-mean[1]!, -mean[2]!), Math.atan2(mean[0]!, Math.hypot(mean[1]!, mean[2]!)))
        window = []; imuFault = ''; gravityCorrection = true
      }
    }
    else {
      let rates = [...value.angularRateRadS] as SensorVector
      gravityCorrection = gravityMode === 'norm-gated' && Math.abs(magnitude - gravity) < 0.15 * gravity
      if (gravityCorrection) {
        const [w, x, y, z] = q
        const down = [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
        const measured = f.map(n => -n / magnitude)
        const error = [measured[1]! * down[2]! - measured[2]! * down[1]!, measured[2]! * down[0]! - measured[0]! * down[2]!, measured[0]! * down[1]! - measured[1]! * down[0]!]
        rates = rates.map((n, i) => n + 2 * error[i]!) as SensorVector
      }
      const angle = Math.hypot(...rates) * dt, scale = angle < 1e-10 ? dt / 2 : Math.sin(angle / 2) * dt / angle
      q = normalizeQuaternion(multiplyQuaternion(q, [Math.cos(angle / 2), rates[0] * scale, rates[1] * scale, rates[2] * scale]))
      imuFault = ''
    }
    imuExpires = now + limits.imu - o.measurementAgeUpperMs!
  }
  function position(o: SensorObservation) {
    const v = o.value as GnssMeasurement
    if (v.frame !== 'WGS84_GEODETIC_NED_VELOCITY' || !vector(v.velocityNedMps) || Math.hypot(...v.velocityNedMps) > 100 || !variance(v.positionVarianceNedM2) || !variance(v.velocityVarianceNedM2S2)) { gpsFault = 'invalid-gnss'; gpsExpires = -Infinity; return }
    const point = { latitudeDeg: v.latitudeDeg, longitudeDeg: v.longitudeDeg, ellipsoidHeightM: v.ellipsoidHeightM }
    try { geodeticToEcef(point) }
    catch { gpsFault = 'invalid-geodetic-fix'; gpsExpires = -Infinity; return }
    if (!origin) origin = structuredClone(point)
    const p = geodeticToNed(point, origin), at = o.estimatedCaptureMs
    const rotation = nedRotation(point, origin)
    const velocity = rotation.map(row => row.reduce((sum, n, i) => sum + n * v.velocityNedMps[i]!, 0))
    const rp = rotation.map(row => row.reduce((sum, n, i) => sum + n * n * v.positionVarianceNedM2[i]!, 0))
    const rv = rotation.map(row => row.reduce((sum, n, i) => sum + n * n * v.velocityVarianceNedM2S2[i]!, 0))
    if (Math.hypot(...p) > 5000) { gpsFault = 'outside-local-frame'; gpsExpires = -Infinity; return }
    if (gpsUs !== null && o.capturedUs <= gpsUs) { gpsFault = 'gnss-time-reversal'; gpsExpires = -Infinity; return }
    if (axes && gpsUs !== null && o.capturedUs - gpsUs > BigInt(limits.gnss * 1000)) { axes = null; resets.position++; event('gnss-reacquired') }
    if (!axes || gpsAtMs === null) axes = p.map((n, i) => ({ p: n, v: velocity[i]!, pp: rp[i]!, pv: 0, vv: rv[i]! }))
    else {
      const predicted = axes.map(s => predictAxis(s, Number(o.capturedUs - gpsUs!) / 1e6))
      const innovation = predicted.reduce((sum, s, i) => sum + (p[i]! - s.p) ** 2 / (s.pp + rp[i]!) + (velocity[i]! - s.v) ** 2 / (s.vv + rv[i]!), 0)
      if (innovation > 36) { gpsFault = 'gnss-innovation-rejected'; gpsExpires = -Infinity; return }
      axes = predicted.map((s, i) => correctAxis(s, p[i]!, velocity[i]!, rp[i]!, rv[i]!))
    }
    gpsAtMs = at; gpsUs = o.capturedUs; gpsExpires = now + limits.gnss - o.measurementAgeUpperMs!; gpsFault = ''
  }
  function pressure(o: SensorObservation) {
    const value = o.value as PressureMeasurement
    if (!Number.isFinite(value.pressurePa) || value.pressurePa < 30000 || value.pressurePa > 110000 || value.variancePa2 === null || !Number.isFinite(value.variancePa2) || value.variancePa2 <= 0) { pressureDown = null; pressureExpires = -Infinity; return }
    pressure0 ??= value.pressurePa
    pressureDown = 44330 * ((value.pressurePa / pressure0) ** 0.190294957 - 1)
    pressureAtMs = o.estimatedCaptureMs; pressureExpires = now + limits.barometer - o.measurementAgeUpperMs!
  }
  function snapshot(atMs: number) {
    clock(atMs)
    const tiltHealthy = q !== null && atMs <= imuExpires
    const positionHealthy = axes !== null && atMs <= gpsExpires && gpsFault === ''
    const predicted = axes && gpsAtMs !== null ? axes.map(s => predictAxis(s, Math.min(1.5, Math.max(0, (atMs - gpsAtMs!) / 1000)))) : null
    return structuredClone({
      nowMs: atMs, bootId: boot, evidence, physicalFlightEnabled: false as const,
      health: { tilt: tiltHealthy, absoluteHeading: false as const, localPosition: positionHealthy, pressureHeight: pressureDown !== null && atMs <= pressureExpires, navigation: false as const },
      quality: ['bench-estimator', 'absolute-heading-unobservable', 'no-inertial-position-fusion', ...(tiltHealthy ? [] : [imuFault || 'imu-stale']), ...(positionHealthy ? [] : [gpsFault || 'gnss-stale']), ...(q && !gravityCorrection ? ['gravity-correction-suppressed'] : [])],
      attitude: q ? { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW' as const, quaternionWxyz: q, eulerRad: quaternionEuler(q), capturedAtMs: lastImuMs, covarianceRad2: null, absoluteHeadingObserved: false as const } : null,
      localPosition: predicted ? { frame: 'LOCAL_NED' as const, origin, altitudeDatum: 'WGS84_ELLIPSOID' as const, positionM: predicted.map(s => s.p), velocityMps: predicted.map(s => s.v), covarianceBlocks: predicted.map(s => ({ positionM2: s.pp, positionVelocityM2S: s.pv, velocityM2S2: s.vv })), capturedAtMs: gpsAtMs, predictedToMs: Math.min(atMs, gpsAtMs! + 1500) } : null,
      pressureHeight: pressureDown !== null ? { frame: 'PRESSURE_RELATIVE_INITIAL' as const, downM: pressureDown, referencePa: pressure0, capturedAtMs: pressureAtMs, varianceM2: null } : null,
      resets, events,
    })
  }
  return {
    snapshot,
    reset(atMs: number) { clock(atMs); resets.manual++; clear('operator-reset'); event('operator-reset'); return snapshot(atMs) },
    update(frame: SensorSnapshot) {
      clock(frame.nowMs)
      if (typeof frame.bootId !== 'bigint' || frame.bootId <= 0n || !['fixture', 'handshake'].includes(frame.evidence)) { clear('invalid-sensor-context'); throw new TypeError('Invalid estimator sensor context') }
      if (evidence !== null && frame.evidence !== evidence) { clear('evidence-source-changed'); throw new TypeError('Estimator evidence source cannot change') }
      evidence = frame.evidence
      if (boot !== null && boot !== frame.bootId) { resets.boot++; clear('board-boot-changed'); event('board-boot-changed') }
      boot = frame.bootId
      for (const kind of ['imu', 'gnss', 'barometer'] as const) {
        const entry = frame.sensors.find(s => s.kind === kind), o = entry?.observation
        if (!entry?.healthy || !qualified(frame, o, kind)) {
          if (kind === 'imu') resetTilt('imu-unhealthy')
          else if (kind === 'gnss') { gpsExpires = -Infinity; gpsFault = 'gnss-unhealthy' }
          else { pressureExpires = -Infinity }
          continue
        }
        const previous = seen[kind]
        if (previous?.sequence === o.sequence && previous.capturedUs === o.capturedUs && previous.deviceId === o.deviceId && previous.calibrationId === o.calibrationId) {
          // A clock refresh can remap this retained sample and tighten its age bound.
          // Refresh metadata only; do not propagate or correct the same sample twice.
          if (kind === 'imu' && lastImuUs === o.capturedUs) { lastImuMs = o.estimatedCaptureMs; imuExpires = now + limits.imu - o.measurementAgeUpperMs! }
          else if (kind === 'gnss' && gpsUs === o.capturedUs && gpsFault === '') { gpsAtMs = o.estimatedCaptureMs; gpsExpires = now + limits.gnss - o.measurementAgeUpperMs! }
          else if (kind === 'barometer' && pressureDown !== null) { pressureAtMs = o.estimatedCaptureMs; pressureExpires = now + limits.barometer - o.measurementAgeUpperMs! }
          continue
        }
        if (previous && (previous.deviceId !== o.deviceId || previous.calibrationId !== o.calibrationId)) {
          if (kind === 'imu') resetTilt('imu-identity-changed')
          else if (kind === 'gnss') { axes = null; gpsAtMs = null; gpsUs = null; resets.position++; event('gnss-identity-changed') }
          else { pressure0 = null; pressureDown = null }
        }
        else if (previous && (o.sequence <= previous.sequence || o.capturedUs <= previous.capturedUs)) {
          if (kind === 'imu') resetTilt('imu-replay')
          else if (kind === 'gnss') { gpsExpires = -Infinity; gpsFault = 'gnss-replay' }
          else pressureExpires = -Infinity
          continue
        }
        seen[kind] = { sequence: o.sequence, capturedUs: o.capturedUs, deviceId: o.deviceId, calibrationId: o.calibrationId }
        if (kind === 'imu') tilt(o)
        else if (kind === 'gnss') position(o)
        else pressure(o)
      }
      return snapshot(frame.nowMs)
    },
  }
}
type GnssEstimatorSnapshot = ReturnType<ReturnType<typeof createEstimator>['snapshot']>
/** Normalized owned navigation snapshot. Pressure/DVL adapters retain their own datum. */
export type EstimatorSnapshot = Omit<GnssEstimatorSnapshot, 'localPosition' | 'pressureHeight'> & { localPosition: (Omit<NonNullable<GnssEstimatorSnapshot['localPosition']>, 'altitudeDatum'> & { altitudeDatum: 'WGS84_ELLIPSOID' | 'LOCAL_WATER_SURFACE' }) | null, pressureHeight: (Omit<NonNullable<GnssEstimatorSnapshot['pressureHeight']>, 'varianceM2'> & { varianceM2: number | null }) | null }
