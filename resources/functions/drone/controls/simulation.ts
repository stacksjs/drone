import type { GnssMeasurement, ImuMeasurement, SensorObservation, SensorVector } from '../sensors/types'
import type { SensorSnapshot } from '../sensors/pipeline'
import type { Quaternion } from '../estimation/frames'
import type { EstimatorSnapshot } from '../estimation/estimator'
import type { RigidBodyState } from './physics'
import type { CargoBoard, CargoBodyRecord, CargoConservation, CargoEstimate, CargoEvaluationReason, CargoEventSide, CargoGnss, CargoImu, CargoLoadCase, CargoLoadEvidence, CargoLoadSnapshot, CargoPhysicalRow, CargoPolicyRow, CargoRawStamp, CargoReadiness, CargoScheduledSeparation, CargoSupervisor } from '../cargo/types'
import type { AuthorityScenario } from '../authority/harness'
import { createAuthorityHarness } from '../authority/harness'
import type { Motors } from './model'
import { createEstimator } from '../estimation/estimator'
import { quaternionEuler } from '../estimation/frames'
import { createRigidBody, rotateBodyToNed } from './physics'
import { createPhysicsSensorFeed } from './sensors'
import { createSimulatedMultirotorController } from './controller'
import { multirotorModel } from './model'
import { quadXWrench } from './allocation'
export const controlScenarios = ['hover', 'step', 'wind', 'delay', 'imu-loss'] as const
export type ControlScenario = typeof controlScenarios[number]
export function simulateMultirotor<const Options extends MultirotorSimulationOptions = MultirotorSimulationOptions>(input: Options = {} as Options) {
  const cargo = captureCargoLoadCase(input)
  const options = cargo ? { scenario: 'hover' as const, seconds: 20, sensorDelayMs: 0, physicsStepMs: 4 as const, authorityScenario: cargo === 'link-loss' ? 'link-loss' as const : 'nominal' as const } : input
  try {
    const scenario = options.scenario ?? 'step', seconds = options.seconds ?? 20, delay = options.sensorDelayMs ?? (scenario === 'delay' ? 20 : 0), stepMs = options.physicsStepMs ?? 4
    if (!controlScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 2 || seconds > 60 || ![2, 4].includes(stepMs)) throw new RangeError('Invalid control scenario, duration (2..60 s) or physics step')
    const authority = options.authorityScenario === undefined ? null : createAuthorityHarness(options.authorityScenario)
    const loadedBody = cargo ? createRigidBody({ carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: cargo === 'centered-carried' ? 0 : 0.08 } }) : null
    const body = loadedBody ?? createRigidBody(), feed = createPhysicsSensorFeed(delay)
    const cargoPhysical: CargoPhysicalRow[] = [], cargoPolicy: CargoPolicyRow[] = []
    let cargoSeparation: CargoScheduledSeparation = { scheduledAtMs: cargo === 'forward-separated' || cargo === 'link-loss' ? 12000 : null, attemptedAtMs: null, outcome: 'not-requested', reason: null, before: null, after: null, parcel: null }
    // Initial world yaw is exactly zero by construction. Only stationary startup uses gravity correction.
    const estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only' })
    const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
    let command: Motors = [0, 0, 0, 0], priorCommand: Motors = [0, 0, 0, 0], output: ReturnType<typeof controller.step> | null = null
    let cargoRateCapturedAtMs: number | null = null
    let sensors = feed.advanceTo(0)
    let estimate = estimator.snapshot(0), state = body.snapshot(), firstInhibitMs: number | null = null, active = false
    let limitedTicks = 0, maxTiltRad = 0, maxCommandSlewNPerS = 0, maxRateRadS = 0, tailError2 = 0, tailCount = 0, groundContacts = 0, maxControlImuAgeMs = 0
    const trace: { atMs: number, positionM: SensorVector, estimatedPositionM: number[] | null, targetM: SensorVector, eulerRad: SensorVector, inhibited: boolean, motorsN: Motors }[] = []
    const targetAt = (at: number): SensorVector => scenario !== 'hover' && at >= 2000 ? [2, 1, -1.5] : [0, 0, -1]
    for (let tick = 0; tick <= Math.floor(seconds * 1000 / stepMs); tick++) {
      const nowMs = tick * stepMs
      if (authority) command = authority.boardTick(nowMs)
      const cargoApplied = cargo ? cargoMotors(command) : null
      const cargoPriorRates = cargo ? cargoVector(state.angularRateRadS) : null
      let cargoBeforeSequence = 0
      if (nowMs > 600) state = body.step(command, stepMs / 1000, { windMps: scenario === 'wind' && nowMs >= 5000 ? [4, -2, 0] : [0, 0, 0], torqueNm: scenario === 'wind' && nowMs >= 7000 && nowMs < 7400 ? [0.03, -0.02, 0.01] : [0, 0, 0] })
      if (!authority || authority.alive(nowMs)) {
        feed.capture(state, nowMs, (scenario === 'imu-loss' || options.authorityScenario === 'estimator-loss') && nowMs >= 3000 && nowMs < 3400)
        sensors = feed.advanceTo(nowMs)
        estimate = estimator.update(sensors)
      }
      const decision = authority && authority.alive(nowMs) ? authority.observe(nowMs, estimate, state, { positionM: targetAt(nowMs), yawRad: 0 }) : undefined
      if (authority && decision?.state !== 'autonomous' && authority.alive(nowMs)) command = [0, 0, 0, 0]
      if (nowMs >= 600 && nowMs % 20 === 0 && (!authority || authority.alive(nowMs))) {
        const observation = sensors.sensors.find(s => s.kind === 'imu')?.observation
        const imu = observation?.value as ImuMeasurement | undefined
        if (cargo) cargoRateCapturedAtMs = observation?.estimatedCaptureMs ?? null
        output = controller.step({ kind: 'simulation', enabled: !authority || decision?.state === 'autonomous', nowMs, estimate, angularRateRadS: imu?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: observation?.estimatedCaptureMs ?? -Infinity, target: { ...(decision?.target ?? { positionM: targetAt(nowMs), yawRad: 0 }), issuedAtMs: nowMs } })
        if (cargo && authority) cargoBeforeSequence = authority.snapshot(nowMs).board.sequence
        command = authority ? authority.apply(output, nowMs) : output.motorsN
        if (!output.inhibited) active = true
        if (active && output.inhibited && firstInhibitMs === null) firstInhibitMs = nowMs
        if (!output.inhibited) maxControlImuAgeMs = Math.max(maxControlImuAgeMs, nowMs - (observation?.estimatedCaptureMs ?? nowMs))
        if (output.limited) limitedTicks++
        if (!output.inhibited) maxCommandSlewNPerS = Math.max(maxCommandSlewNPerS, ...command.map((n, i) => Math.abs(n - priorCommand[i]!) / 0.02))
        priorCommand = [...command]
      }
      if (cargo && loadedBody && authority) {
        const load = cargoLoad(loadedBody.loadSnapshot()), wrench = quadXWrench(state.motorsN)
        cargoRetain(cargoPhysical, {
          atMs: nowMs, stepKind: nowMs <= 600 ? 'held-support' : 'integrated', load, body: cargoBody(state),
          commandAppliedN: cargoApplied!, commandNextN: cargoMotors(command), thrustN: cargoNumber(wrench.thrustN, 0), motorTorqueAtBNm: cargoVector(wrench.torqueNm),
          motorTorqueAtCgNm: cargoVector([wrench.torqueNm[0], wrench.torqueNm[1] - load.properties.cgBodyM[0] * wrench.thrustN, wrench.torqueNm[2]]),
          alphaStepRadS2: nowMs <= 600 ? [0, 0, 0] : cargoVector(state.angularRateRadS.map((n, i) => (n - cargoPriorRates![i]!) / (stepMs / 1000))),
        }, 5001)
        if (nowMs % 20 === 0) {
          // This snapshot is read-only and occurs after the sole ordinary apply/gate.
          const current = authority.snapshot(nowMs), imu = cargoImu(sensors)
          const row: CargoPolicyRow = {
            atMs: nowMs, imu, gnss: cargoGnss(sensors), estimate: cargoEstimate(estimate, nowMs),
            control: output ? { inhibited: cargoBoolean(output.inhibited), reason: cargoText(output.reason, 96), motorsN: cargoMotors(output.motorsN), limited: cargoBoolean(output.limited), rateCapturedAtMs: cargoTime(cargoRateCapturedAtMs, 20000, false) } : null,
            supervisor: cargoSupervisor(current), board: cargoBoard(current), readiness: { qualified: false, count: 0, startAtMs: null, lastImuSequence: null, lastImuCapturedUs: null },
          }
          row.readiness = cargoReadiness(row, cargoPolicy[cargoPolicy.length - 1], cargoBeforeSequence)
          cargoRetain(cargoPolicy, row, 1001)
        }
      }
      if ((cargo === 'forward-separated' || cargo === 'link-loss') && nowMs === 12000 && loadedBody) {
        const row = cargoPolicy[cargoPolicy.length - 1]!, load = cargoLoad(loadedBody.loadSnapshot())
        const refusal = !cargoAuthorityCurrent(row) ? 'authority-not-current' : !cargoBoardCurrent(row, cargoBeforeSequence) ? 'board-not-current' : row.control === null || row.control.inhibited ? 'control-inhibited' : !row.readiness.qualified || row.readiness.count !== 26 || row.readiness.startAtMs !== 11500 ? 'readiness-window' : load.properties.phase === 'separated' ? 'already-separated' : null
        if (refusal !== null) cargoSeparation = { scheduledAtMs: 12000, attemptedAtMs: 12000, outcome: 'refused', reason: refusal, before: cargoEventSide(state, load), after: null, parcel: null }
        else {
          const event = loadedBody.separateCarriedLoad()
          cargoSeparation = event.outcome === 'separated'
            ? { scheduledAtMs: 12000, attemptedAtMs: 12000, outcome: 'separated', reason: 'prescribed-zero-ejection', before: cargoProjectEventSide(event.before), after: cargoProjectEventSide(event.after), parcel: { massKg: cargoNumber(event.parcel.massKg, 0, 0.25), positionM: cargoVector(event.parcel.positionM), velocityMps: cargoVector(event.parcel.velocityMps) } }
            : { scheduledAtMs: 12000, attemptedAtMs: 12000, outcome: 'refused', reason: 'already-separated', before: cargoEventSide(state, load), after: null, parcel: null }
          state = loadedBody.snapshot()
        }
      }
      const euler = quaternionEuler(state.quaternionWxyz)
      if (nowMs > 600) {
        maxTiltRad = Math.max(maxTiltRad, Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (state.quaternionWxyz[1] ** 2 + state.quaternionWxyz[2] ** 2)))))
        maxRateRadS = Math.max(maxRateRadS, Math.hypot(...state.angularRateRadS))
        if (state.groundContact) groundContacts++
        if (nowMs >= seconds * 1000 - 2000) { tailError2 += state.positionM.reduce((sum, n, i) => sum + (n - targetAt(nowMs)[i]!) ** 2, 0); tailCount++ }
      }
      if (nowMs % 200 === 0) trace.push({ atMs: nowMs, positionM: [...state.positionM], estimatedPositionM: estimate.localPosition?.positionM ?? null, targetM: targetAt(nowMs), eulerRad: euler, inhibited: authority ? !authority.alive(nowMs) || decision?.state !== 'autonomous' : output?.inhibited ?? true, motorsN: [...command] })
    }
    const finalTarget = targetAt(seconds * 1000)
    const result = {
      evidence: 'owned-rigid-body-simulation' as const, scenario, seconds, physicsStepMs: stepMs, additionalSensorDelayMs: delay,
      physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, headingAlignment: 'declared-initial-simulation-north', gravityCorrection: 'initialization-only', supportWarmupMs: 600,
      model: multirotorModel, response: {
        targetStepAtMs: scenario === 'hover' ? null : 2000,
        positionSettledAtMs: trace.find((row, index) => row.atMs >= (scenario === 'wind' ? 8000 : 2000) && trace.slice(index).length >= 6 && trace.slice(index).every(next => Math.hypot(...next.positionM.map((n, i) => n - next.targetM[i]!)) < 0.2))?.atMs ?? null,
        peakPositionErrorAfterStepM: Math.max(...trace.filter(row => row.atMs >= 2000).map(row => Math.hypot(...row.positionM.map((n, i) => n - row.targetM[i]!)))),
      }, metrics: { active, firstInhibitMs, finalPositionErrorM: Math.hypot(...state.positionM.map((n, i) => n - finalTarget[i]!)), tailPositionRmsM: Math.sqrt(tailError2 / Math.max(1, tailCount)), maxTiltRad, maxRateRadS, maxCommandSlewNPerS, limitedTicks, groundContacts, maxControlImuAgeMs },
      state, estimate, control: output, trace, authority: authority?.snapshot(seconds * 1000) ?? null,
    }
    const extended = cargo && authority ? { ...result, cargoLoadEvidence: finishCargoEvidence(cargo, cargoPhysical, cargoPolicy, cargoSeparation, authority.snapshot(seconds * 1000)) } : result
    // Own-option validation and the selected owned world establish the opt-in return refinement.
    return extended as typeof result & (Options extends { cargoLoadCase: CargoLoadCase } ? { cargoLoadEvidence: CargoLoadEvidence } : object)
  }
  catch (error) {
    if (cargo) cargoUnavailable()
    throw error
  }
}

interface MultirotorSimulationOptions {
  scenario?: ControlScenario
  seconds?: number
  sensorDelayMs?: number
  physicsStepMs?: 2 | 4
  authorityScenario?: AuthorityScenario
  cargoLoadCase?: CargoLoadCase
}

/** Only an actual own data member opts into the fixed cargo fixture. */
function captureCargoLoadCase(input: unknown): CargoLoadCase | null {
  try {
    if (!input || (typeof input !== 'object' && typeof input !== 'function') || !Object.getOwnPropertyDescriptor(input, 'cargoLoadCase')) return null
    if (typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input)
    const allowed = ['scenario', 'seconds', 'sensorDelayMs', 'physicsStepMs', 'authorityScenario', 'cargoLoadCase']
    const captured: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError()
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) throw new TypeError()
      captured[key] = descriptor.value
    }
    const scenario = captured.cargoLoadCase
    if (typeof scenario !== 'string' || !['centered-carried', 'forward-carried', 'forward-separated', 'link-loss'].includes(scenario)) throw new TypeError()
    const expected: Record<string, unknown> = { scenario: 'hover', seconds: 20, sensorDelayMs: 0, physicsStepMs: 4, authorityScenario: scenario === 'link-loss' ? 'link-loss' : 'nominal' }
    for (const key of allowed.slice(0, -1)) if (Object.hasOwn(captured, key) && captured[key] !== expected[key]) throw new TypeError()
    return scenario as CargoLoadCase
  }
  catch { throw new TypeError('cargo-load-options') }
}

function cargoUnavailable(): never { throw new RangeError('cargo-load-unavailable') }
function cargoNumber(value: number, min = -1e6, max = 1e6, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) cargoUnavailable()
  return value
}
function cargoTime(value: number | null, max = 20000, integer = true): number | null {
  return value === null ? null : cargoNumber(value, 0, max, integer)
}
function cargoIdentity(value: bigint, zero = false): string {
  if (typeof value !== 'bigint' || value < (zero ? 0n : 1n) || value > 0xFFFFFFFFFFFFFFFFn) cargoUnavailable()
  return value.toString(10)
}
function cargoText(value: string, max: number, code = false): string {
  if (typeof value !== 'string' || value.length > max || (code ? !/^[a-z]/.test(value) || /[^a-z0-9-]/.test(value) : /[^ -~]/.test(value))) cargoUnavailable()
  return value
}
function cargoBoolean(value: boolean): boolean {
  if (typeof value !== 'boolean') cargoUnavailable()
  return value
}
function cargoVector(value: readonly number[]): SensorVector {
  if (!Array.isArray(value) || value.length !== 3) cargoUnavailable()
  return [cargoNumber(value[0]!), cargoNumber(value[1]!), cargoNumber(value[2]!)]
}
function cargoMotors(value: readonly number[]): Motors {
  if (!Array.isArray(value) || value.length !== 4) cargoUnavailable()
  return [cargoNumber(value[0]!, 0, 10), cargoNumber(value[1]!, 0, 10), cargoNumber(value[2]!, 0, 10), cargoNumber(value[3]!, 0, 10)]
}
function cargoQuaternion(value: readonly number[]): Quaternion {
  if (!Array.isArray(value) || value.length !== 4 || Math.abs(Math.hypot(...value) - 1) > 1e-6) cargoUnavailable()
  return [cargoNumber(value[0]!, -1, 1), cargoNumber(value[1]!, -1, 1), cargoNumber(value[2]!, -1, 1), cargoNumber(value[3]!, -1, 1)]
}
function cargoBody(state: RigidBodyState): CargoBodyRecord {
  return { positionM: cargoVector(state.positionM), velocityMps: cargoVector(state.velocityMps), accelerationMps2: cargoVector(state.accelerationMps2), quaternionWxyz: cargoQuaternion(state.quaternionWxyz), angularRateRadS: cargoVector(state.angularRateRadS), actualMotorsN: cargoMotors(state.motorsN), groundContact: cargoBoolean(state.groundContact) }
}
function cargoLoad(load: CargoLoadSnapshot): CargoLoadSnapshot {
  const p = load.properties
  if (!['attached', 'separated'].includes(p.phase)) cargoUnavailable()
  return { properties: { id: cargoText(p.id, 40, true), phase: p.phase, pointMassKg: cargoNumber(p.pointMassKg, 0, 0.25), forwardM: cargoNumber(p.forwardM, -0.1, 0.1), totalMassKg: cargoNumber(p.totalMassKg, 1.5, 1.75), cgBodyM: cargoVector(p.cgBodyM), inertiaDiagonalKgM2: cargoVector(p.inertiaDiagonalKgM2) }, centerPositionM: cargoVector(load.centerPositionM), centerVelocityMps: cargoVector(load.centerVelocityMps) }
}
function cargoStamp(o: SensorObservation): CargoRawStamp {
  if (o.quality.length > 8) cargoUnavailable()
  return { sequence: cargoNumber(o.sequence, 0, 1e6, true), capturedUs: cargoIdentity(o.capturedUs, true), capturedAtMs: cargoNumber(o.estimatedCaptureMs, 0, 20000), receivedAtMs: cargoNumber(o.receivedAtMs, 0, 20000, true), ageUpperMs: o.measurementAgeUpperMs === null ? null : cargoNumber(o.measurementAgeUpperMs, 0), uncertaintyUs: o.timeUncertaintyUs === null ? null : cargoNumber(o.timeUncertaintyUs, 0), deviceId: cargoText(o.deviceId, 128), calibrationId: o.calibrationId === null ? null : cargoText(o.calibrationId, 128), healthy: cargoBoolean(o.healthy), quality: o.quality.map(q => cargoText(q, 48, true)) }
}
function cargoImu(sensors: SensorSnapshot): CargoImu | null {
  const o = sensors.sensors.find(s => s.kind === 'imu')?.observation
  if (!o || o.value === null) return null
  const v = o.value as ImuMeasurement
  if (o.kind !== 'imu' || v.frame !== 'BODY_FRD') cargoUnavailable()
  return { stamp: cargoStamp(o), specificForceMps2: cargoVector(v.specificForceMps2), angularRateRadS: cargoVector(v.angularRateRadS) }
}
function cargoGnss(sensors: SensorSnapshot): CargoGnss | null {
  const o = sensors.sensors.find(s => s.kind === 'gnss')?.observation
  if (!o || o.value === null) return null
  const v = o.value as GnssMeasurement
  if (o.kind !== 'gnss' || v.frame !== 'WGS84_GEODETIC_NED_VELOCITY') cargoUnavailable()
  return { stamp: cargoStamp(o), geodetic: cargoVector([v.latitudeDeg, v.longitudeDeg, v.ellipsoidHeightM]), velocityNedMps: cargoVector(v.velocityNedMps) }
}
function cargoEstimate(e: EstimatorSnapshot, nowMs: number): CargoEstimate {
  const a = e.attitude, p = e.localPosition, origin = p?.origin
  const resets: CargoEstimate['resets'] = [e.resets.attitude, e.resets.position, e.resets.boot, e.resets.manual, e.resets.clock].map(n => cargoNumber(n, 0, 1e6, true)) as CargoEstimate['resets']
  return {
    nowMs: cargoNumber(e.nowMs, 0, 20000, true), bootId: e.bootId === null ? null : cargoIdentity(e.bootId), resets,
    origin: origin ? cargoVector([origin.latitudeDeg, origin.longitudeDeg, origin.ellipsoidHeightM]) : null,
    frameQualified: e.nowMs === nowMs && e.evidence === 'fixture' && e.physicalFlightEnabled === false && e.bootId === 55n && resets.every(n => n === 0)
      && a !== null && a.reference === 'GRAVITY_ALIGNED_RELATIVE_YAW' && Math.abs(Math.hypot(...a.quaternionWxyz) - 1) <= 1e-6
      && p !== null && p.frame === 'LOCAL_NED' && p.altitudeDatum === 'WGS84_ELLIPSOID'
      && !!origin && origin.latitudeDeg === 0 && origin.longitudeDeg === 0 && origin.ellipsoidHeightM === 100,
    healthy: [cargoBoolean(e.health.tilt), cargoBoolean(e.health.localPosition)],
    attitude: a ? { capturedAtMs: cargoTime(a.capturedAtMs, 20000, false), quaternionWxyz: cargoQuaternion(a.quaternionWxyz) } : null,
    position: p ? { capturedAtMs: cargoTime(p.capturedAtMs, 20000, false), predictedToMs: cargoNumber(p.predictedToMs, 0, 20000, true), positionM: cargoVector(p.positionM), velocityMps: cargoVector(p.velocityMps) } : null,
  }
}
type CargoAuthoritySnapshot = ReturnType<ReturnType<typeof createAuthorityHarness>['snapshot']>
function cargoSupervisor(snapshot: CargoAuthoritySnapshot): CargoSupervisor {
  const s = snapshot.supervisor
  if (!['disarmed', 'armed-idle', 'autonomous', 'manual', 'failsafe', 'killed'].includes(s.state)) cargoUnavailable()
  return { scope: [cargoIdentity(s.sessionId), cargoIdentity(s.bootId)], state: s.state, reason: cargoText(s.reason, 96), epoch: cargoNumber(s.epoch, 0, 0xFFFFFFFF, true), commandSequence: cargoNumber(s.sequence, -1, 1e6, true), lastCheckedAtMs: cargoTime(s.lastCheckedAtMs), leaseUntilMs: cargoTime(s.leaseUntilMs, 20100) }
}
function cargoBoard(snapshot: CargoAuthoritySnapshot): CargoBoard {
  const b = snapshot.board
  return { bootId: cargoIdentity(b.bootId), epoch: cargoNumber(b.epoch, -1, 0xFFFFFFFF, true), frameSequence: cargoNumber(b.sequence, 0, 1e6, true), lastCheckedAtMs: cargoTime(b.lastCheckedAtMs), expiresAtMs: cargoTime(b.expiresAtMs, 20100), fault: b.fault === null ? null : cargoText(b.fault, 96), motorsN: cargoMotors(b.motorsN) }
}
function cargoAuthorityCurrent(row: CargoPolicyRow): boolean {
  const s = row.supervisor
  return s.state === 'autonomous' && s.scope[0] === '123' && s.scope[1] === '55' && s.lastCheckedAtMs === row.atMs && s.leaseUntilMs !== null && s.leaseUntilMs > row.atMs
}
function cargoBoardCurrent(row: CargoPolicyRow, beforeSequence: number): boolean {
  const b = row.board, s = row.supervisor, c = row.control
  return b.bootId === '55' && b.epoch === s.epoch && b.fault === null && b.lastCheckedAtMs === row.atMs && b.expiresAtMs !== null && b.expiresAtMs > row.atMs
    && s.leaseUntilMs !== null && b.expiresAtMs <= s.leaseUntilMs && b.frameSequence > beforeSequence && c !== null && b.motorsN.every((n, i) => n === c.motorsN[i])
}
function cargoEstimateCurrent(row: CargoPolicyRow): boolean {
  const e = row.estimate, a = e.attitude, p = e.position, imu = row.imu, gnss = row.gnss, now = row.atMs
  const fresh = (at: number | null, age: number) => at !== null && at <= now && now - at <= age
  const raw = (s: CargoRawStamp | undefined, maxAge: number) => !!s && s.healthy && fresh(s.capturedAtMs, maxAge) && fresh(s.receivedAtMs, maxAge)
    && s.ageUpperMs !== null && s.ageUpperMs >= now - s.capturedAtMs && s.ageUpperMs <= maxAge && s.uncertaintyUs !== null && s.uncertaintyUs >= 0
    && !s.quality.some(q => ['stream-overrun', 'timing-unvalidated', 'measurement-epoch-unaligned', 'stuck-suspected'].includes(q))
  return e.nowMs === now && e.frameQualified && e.healthy.every(Boolean) && !!a && !!p && fresh(a.capturedAtMs, 60) && fresh(p.capturedAtMs, 200) && fresh(p.predictedToMs, 40)
    && raw(imu?.stamp, 60) && raw(gnss?.stamp, 200) && a.capturedAtMs === imu!.stamp.capturedAtMs && row.control?.rateCapturedAtMs === imu!.stamp.capturedAtMs
}
function cargoTilt(q: Quaternion): number { return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[1] ** 2 + q[2] ** 2)))) }
function withinRoundedCargoCommandStep(previous: number, next: number): boolean {
  if (![previous, next].every(n => Number.isFinite(n) && n >= 0 && n <= 10)) return false
  const representedStepN = 40 * 0.02
  return next >= previous - representedStepN && next <= previous + representedStepN
}
function cargoReadiness(row: CargoPolicyRow, previous: CargoPolicyRow | undefined, beforeSequence: number): CargoReadiness {
  const imu = row.imu, e = row.estimate, p = e.position, a = e.attitude, last = previous?.imu
  const sameReference = !previous || (e.bootId === previous.estimate.bootId && e.resets.every((n, i) => n === previous.estimate.resets[i])
    && e.origin !== null && previous.estimate.origin !== null && e.origin.every((n, i) => n === previous.estimate.origin![i])
    && !!last && !!imu && imu.stamp.deviceId === last.stamp.deviceId && imu.stamp.calibrationId === last.stamp.calibrationId)
  const newImu = !!imu && (!last || (imu.stamp.sequence > last.stamp.sequence && BigInt(imu.stamp.capturedUs) > BigInt(last.stamp.capturedUs) && imu.stamp.capturedAtMs > last.stamp.capturedAtMs))
  const valid = cargoAuthorityCurrent(row) && cargoBoardCurrent(row, beforeSequence) && row.control !== null && !row.control.inhibited
    && cargoEstimateCurrent(row) && !!p && !!a && Math.hypot(...p.velocityMps) <= 0.3 && Math.hypot(p.positionM[0], p.positionM[1], p.positionM[2] + 1) <= 0.3 && cargoTilt(a.quaternionWxyz) <= 0.25
    && newImu && sameReference
  if (!valid) return { qualified: false, count: 0, startAtMs: null, lastImuSequence: null, lastImuCapturedUs: null }
  const continuous = previous !== undefined && previous.atMs + 20 === row.atMs && previous.readiness.count > 0
  const count = continuous ? Math.min(26, previous.readiness.count + 1) : 1
  const startAtMs = count === 26 ? row.atMs - 500 : continuous ? previous.readiness.startAtMs : row.atMs
  return { qualified: count === 26, count, startAtMs, lastImuSequence: imu!.stamp.sequence, lastImuCapturedUs: imu!.stamp.capturedUs }
}
function cargoBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length }
function cargoRetain<Row>(rows: Row[], row: Row, limit: number) {
  if (rows.length >= limit || cargoBytes(row) > 2048) cargoUnavailable()
  rows.push(row)
}

/** Fixed carried-load evaluation uses retained 4 ms world facts, never the legacy decimated trace. */
function finishCargoEvidence(scenario: CargoLoadCase, physical: CargoPhysicalRow[], policy: CargoPolicyRow[], separation: CargoScheduledSeparation, finalAuthority: CargoAuthoritySnapshot): CargoLoadEvidence {
  if (physical.length !== 5001 || policy.length !== 1001) cargoUnavailable()
  const integrated = physical.filter(row => row.stepKind === 'integrated'), held = physical.filter(row => row.stepKind === 'held-support')
  if (integrated.length !== 4850 || held.length !== 151 || physical.some((row, i) => row.atMs !== i * 4) || policy.some((row, i) => row.atMs !== i * 20)) cargoUnavailable()
  const linkLoss = scenario === 'link-loss'
  let maxTiltRad = 0, maxRateRadS = 0, maxCommandSlewNPerS = 0, groundContactRows = 0, tailMaxPositionErrorM = 0, tailErrorSquared = 0, tailCount = 0
  let nominalTiltRad = 0, nominalRateRadS = 0, nominalCommandSlewNPerS = 0, nominalGroundContacts = 0
  let authorityLost = false, controlInhibited = false, estimateUnqualified = false, commandStepRealizationPassed = true
  let previous: Motors = [0, 0, 0, 0]
  for (let i = 0; i < policy.length; i++) {
    const row = policy[i]!
    if (row.atMs < 600) continue
    if (!cargoAuthorityCurrent(row) || !cargoBoardCurrent(row, policy[i - 1]?.board.frameSequence ?? 0)) authorityLost = true
    const nominal = !linkLoss || row.atMs < 3000
    if (nominal && (!row.control || row.control.inhibited)) controlInhibited = true
    if (nominal && !cargoEstimateCurrent(row)) estimateUnqualified = true
    if (row.control) {
      if (nominal && !row.control.motorsN.every((n, index) => withinRoundedCargoCommandStep(previous[index]!, n))) commandStepRealizationPassed = false
      const rawSlew = Math.max(...row.control.motorsN.map((n, index) => Math.abs(n - previous[index]!) / 0.02))
      maxCommandSlewNPerS = Math.max(maxCommandSlewNPerS, rawSlew)
      if (nominal) nominalCommandSlewNPerS = Math.max(nominalCommandSlewNPerS, rawSlew)
      previous = [...row.control.motorsN]
    }
  }
  for (const row of integrated) {
    maxTiltRad = Math.max(maxTiltRad, cargoTilt(row.body.quaternionWxyz)); maxRateRadS = Math.max(maxRateRadS, Math.hypot(...row.body.angularRateRadS))
    if (row.body.groundContact) groundContactRows++
    if (!linkLoss || row.atMs < 3000) { nominalTiltRad = Math.max(nominalTiltRad, cargoTilt(row.body.quaternionWxyz)); nominalRateRadS = Math.max(nominalRateRadS, Math.hypot(...row.body.angularRateRadS)); if (row.body.groundContact) nominalGroundContacts++ }
    if (row.atMs >= 18000 && row.atMs <= 20000) { const error = Math.hypot(row.body.positionM[0], row.body.positionM[1], row.body.positionM[2] + 1); tailMaxPositionErrorM = Math.max(tailMaxPositionErrorM, error); tailErrorSquared += error * error; tailCount++ }
  }
  if (tailCount !== 501) cargoUnavailable()
  const tailRmsPositionErrorM = Math.sqrt(tailErrorSquared / tailCount), reasons: CargoEvaluationReason[] = []
  const forwardM = scenario === 'centered-carried' ? 0 : 0.08
  const separated = separation.outcome === 'separated'
  const separationCount = physical.reduce((count, row, i) => count + (i > 0 && row.load.properties.phase !== physical[i - 1]!.load.properties.phase ? 1 : 0), 0)
  const conservation = separated ? cargoConservation(separation) : null
  const loadConsistent = physical.every(row => cargoPropertiesMatch(row.load.properties, separated && row.atMs > 12000 ? 'separated' : 'attached', forwardM))
  const eventConsistent = separated ? separationCount === 1 && scenario === 'forward-separated' && separation.attemptedAtMs === 12000 && conservation !== null && conservation.passed : separationCount === 0
  if (!loadConsistent || !eventConsistent) reasons.push('cargo-load-conservation')
  if (authorityLost || linkLoss) reasons.push('cargo-load-authority-lost')
  if (controlInhibited) reasons.push('cargo-load-control-inhibited')
  if (estimateUnqualified) reasons.push('cargo-load-estimate-unqualified')
  if (nominalGroundContacts > 0) reasons.push('cargo-load-ground-contact')
  // Rounded endpoint realization and its derived binary64 reconstruction ceiling; raw metrics stay unchanged.
  if (nominalTiltRad > 0.35 || nominalRateRadS > 2 || !commandStepRealizationPassed || nominalCommandSlewNPerS > 40 + 2 ** -44) reasons.push('cargo-load-body-envelope')
  if ((scenario === 'forward-separated' || linkLoss) && !separated) reasons.push('cargo-load-separation-refused')
  if (!linkLoss && (tailMaxPositionErrorM > 0.4 || tailRmsPositionErrorM > 0.3)) reasons.push('cargo-load-hover-tail')
  const last = physical[physical.length - 1]!
  const evidence: CargoLoadEvidence = {
    version: 1, scenario,
    model: { baseMassKg: 1.5, baseInertia: [0.03, 0.03, 0.05], gravityMps2: 9.80665, loadMassKg: 0.1, loadForwardM: forwardM, dtMs: 4, policyMs: 20, durationMs: 20000, supportWarmupMs: 600, separationAtMs: scenario === 'forward-separated' || linkLoss ? 12000 : null, targetM: [0, 0, -1], massAwareController: false, inertialPositionFusion: false, separationModel: 'prescribed-instantaneous-zero-ejection-point-mass', energyModel: 'not-qualified', contactModel: 'structural-point-plane-approximation' },
    counts: { worldSnapshots: physical.length, heldSupportRows: held.length, integratedSteps: integrated.length, policyRows: policy.length, separationAttempts: separation.attemptedAtMs === null ? 0 : 1, separationTransitions: separationCount },
    separation,
    physical, policy,
    evaluation: { reasons, metrics: { maxTiltRad: cargoNumber(maxTiltRad, 0), maxRateRadS: cargoNumber(maxRateRadS, 0), maxCommandSlewNPerS: cargoNumber(maxCommandSlewNPerS, 0), groundContactRows: cargoNumber(groundContactRows, 0, 1e6, true), tailMaxPositionErrorM: cargoNumber(tailMaxPositionErrorM, 0), tailRmsPositionErrorM: cargoNumber(tailRmsPositionErrorM, 0), firstAuthorityLossAtMs: cargoTime(finalAuthority.firstRevocationMs), firstBoardZeroAtMs: cargoTime(finalAuthority.firstZeroMs), separationCount, conservation }, faultCharacterizationPassed: linkLoss ? cargoFaultCharacterization(physical, policy, separation, finalAuthority) : null },
    final: { body: structuredClone(last.body), load: structuredClone(last.load), supervisor: cargoSupervisor(finalAuthority), board: cargoBoard(finalAuthority), experimentEnded: true, landingPerformed: false },
  }
  // Evidence-local bounds. The later CargoLoadRun projection must also bound its complete envelope.
  if (cargoBytes({ ...evidence, physical: [], policy: [] }) > 131072 || cargoBytes(evidence) + 1 > 12582912) cargoUnavailable()
  return evidence
}

function cargoProjectEventSide(side: CargoEventSide): CargoEventSide {
  const load = cargoLoad({ properties: side.properties, centerPositionM: side.centerPositionM, centerVelocityMps: side.centerVelocityMps })
  return { properties: load.properties, bodyPositionM: cargoVector(side.bodyPositionM), bodyVelocityMps: cargoVector(side.bodyVelocityMps), quaternionWxyz: cargoQuaternion(side.quaternionWxyz), angularRateRadS: cargoVector(side.angularRateRadS), actualMotorsN: cargoMotors(side.actualMotorsN), centerPositionM: load.centerPositionM, centerVelocityMps: load.centerVelocityMps }
}
function cargoEventSide(state: RigidBodyState, load: CargoLoadSnapshot): CargoEventSide {
  return cargoProjectEventSide({ properties: load.properties, bodyPositionM: state.positionM, bodyVelocityMps: state.velocityMps, quaternionWxyz: state.quaternionWxyz, angularRateRadS: state.angularRateRadS, actualMotorsN: state.motorsN, centerPositionM: load.centerPositionM, centerVelocityMps: load.centerVelocityMps })
}
function cargoPropertiesMatch(p: CargoLoadSnapshot['properties'], phase: 'attached' | 'separated', forwardM: number): boolean {
  const mass = phase === 'attached' ? 1.6 : 1.5, cx = phase === 'attached' ? 0.1 * forwardM / 1.6 : 0
  const shift = phase === 'attached' ? 1.5 * 0.1 / 1.6 * forwardM ** 2 : 0
  const cg = [cx, 0, 0]
  const inertia = [0.03, 0.03 + shift, 0.05 + shift]
  return p.id === 'cargo-point-100g' && p.phase === phase && p.pointMassKg === 0.1 && p.forwardM === forwardM && p.totalMassKg === mass && p.cgBodyM.every((n, i) => n === cg[i]) && p.inertiaDiagonalKgM2.every((n, i) => n === inertia[i])
}
function cargoCross(a: SensorVector, b: SensorVector): SensorVector { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
function cargoAdd(a: SensorVector, b: SensorVector): SensorVector { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function cargoSubtract(a: SensorVector, b: SensorVector): SensorVector { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function cargoScale(a: SensorVector, k: number): SensorVector { return [a[0] * k, a[1] * k, a[2] * k] }
function cargoConservation(separation: CargoScheduledSeparation): CargoConservation {
  const before = separation.before, after = separation.after, parcel = separation.parcel
  if (!before || !after || !parcel) cargoUnavailable()
  const origin: SensorVector = [1, -2, 0.5], m = before.properties.totalMassKg, mb = after.properties.totalMassKg, mp = parcel.massKg
  const preP = cargoScale(before.centerVelocityMps, m), baseP = cargoScale(after.bodyVelocityMps, mb), parcelP = cargoScale(parcel.velocityMps, mp), postP = cargoAdd(baseP, parcelP)
  const rotation = before.quaternionWxyz
  const spin0 = rotateBodyToNed(rotation, before.angularRateRadS.map((n, i) => n * before.properties.inertiaDiagonalKgM2[i]!) as SensorVector)
  const spin1 = rotateBodyToNed(after.quaternionWxyz, after.angularRateRadS.map((n, i) => n * after.properties.inertiaDiagonalKgM2[i]!) as SensorVector)
  const preH = cargoAdd(cargoCross(cargoSubtract(before.centerPositionM, origin), preP), spin0)
  const postH = cargoAdd(cargoAdd(cargoCross(cargoSubtract(after.bodyPositionM, origin), baseP), spin1), cargoCross(cargoSubtract(parcel.positionM, origin), parcelP))
  const norm2 = (v: SensorVector) => v.reduce((sum, n) => sum + n * n, 0)
  const rotationEnergy = (side: CargoEventSide) => 0.5 * side.angularRateRadS.reduce((sum, n, i) => sum + side.properties.inertiaDiagonalKgM2[i]! * n * n, 0)
  const preK = 0.5 * m * norm2(before.centerVelocityMps) + rotationEnergy(before), postK = 0.5 * mb * norm2(after.bodyVelocityMps) + rotationEnergy(after) + 0.5 * mp * norm2(parcel.velocityMps)
  const preU = -m * 9.80665 * before.centerPositionM[2], postU = -mb * 9.80665 * after.bodyPositionM[2] - mp * 9.80665 * parcel.positionM[2]
  const continuityMax = Math.max(...(['bodyPositionM', 'bodyVelocityMps', 'quaternionWxyz', 'angularRateRadS', 'actualMotorsN'] as const).flatMap(key => before[key].map((n, i) => Math.abs(n - after[key][i]!))))
  const conserved = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 + 1e-10 * Math.max(Math.abs(a), Math.abs(b))
  const passed = preP.every((n, i) => conserved(n, postP[i]!)) && preH.every((n, i) => conserved(n, postH[i]!)) && conserved(preK, postK) && conserved(preU, postU) && continuityMax <= 1e-12
    && cargoPropertiesMatch(before.properties, 'attached', 0.08) && cargoPropertiesMatch(after.properties, 'separated', 0.08) && mp === 0.1
  return { originM: origin, linearResidual: cargoVector(cargoSubtract(preP, postP)), angularResidual: cargoVector(cargoSubtract(preH, postH)), kineticResidualJ: cargoNumber(preK - postK), potentialResidualJ: cargoNumber(preU - postU), continuityMax: cargoNumber(continuityMax, 0), passed }
}

function cargoFaultCharacterization(physical: CargoPhysicalRow[], policy: CargoPolicyRow[], separation: CargoScheduledSeparation, authority: CargoAuthoritySnapshot): boolean {
  const atLoss = physical.find(row => row.atMs === 3000)
  const zero = (motors: Motors) => motors.every(n => n === 0)
  const zeroCommands = policy.filter(row => row.atMs >= 3000).every(row => zero(row.board.motorsN) && row.supervisor.state === 'failsafe')
    && physical.filter(row => row.atMs >= 3000).every(row => zero(row.commandNextN)) && physical.filter(row => row.atMs >= 3004).every(row => zero(row.commandAppliedN))
  const actualLag = !!atLoss && atLoss.commandAppliedN.some(n => n > 0) && atLoss.body.actualMotorsN.some(n => n > 0)
    && physical.every((row, i) => row.atMs < 3004 || row.body.actualMotorsN.every((n, motor) => Math.abs(n - physical[i - 1]!.body.actualMotorsN[motor]! * Math.exp(-0.004 / 0.04)) <= 1e-12))
  return authority.firstRevocationMs === 3000 && authority.firstZeroMs === 3000 && zeroCommands && actualLag
    && separation.scheduledAtMs === 12000 && separation.attemptedAtMs === 12000 && separation.outcome === 'refused' && separation.reason === 'authority-not-current'
    && physical.every(row => row.load.properties.phase === 'attached')
}
