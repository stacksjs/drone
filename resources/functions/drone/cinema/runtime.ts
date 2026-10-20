import { types as nodeTypes } from 'node:util'
import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { MissionSimulationContext } from '../missions/simulation'
import type { VehicleMeasurementPose } from '../vehicles/types'
import type { CinemaActualCapture, CinemaCapture, CinemaEncoder, CinemaFault, CinemaFaultCode, CinemaImage, CinemaReason, CinemaRetirement, CinemaRun, CinemaScenario, CinemaSelection, CinemaTarget } from './types'
import { cinemaScenarios } from './types'
import { simulateMission } from '../missions/simulation'
import { validateMission } from '../missions/plan'
import { predictVehicleMeasurementPose, vehicleReference } from '../vehicles/measurements'
import { createModeledCamera } from '../payloads/modeled-camera'
import { cinemaGoal, cinemaOffset, createCinemaGimbal, evaluateCinemaMotion, withinCinemaTravel } from './gimbal'
import { cinemaImageQuality, cinemaModel, createCinemaRenderer } from './camera'
export { cinemaScenarios } from './types'
export type { CinemaRun, CinemaScenario } from './types'

const reference = '55:0,0,0,0,0' as const
function captureScenario(input: unknown): CinemaScenario {
  try {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input)
    if (keys.some(k => k !== 'scenario') || keys.length > 1) throw new TypeError()
    const descriptor = descriptors.scenario
    if (!descriptor) return 'nominal'
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !cinemaScenarios.includes(descriptor.value as CinemaScenario)) throw new TypeError()
    return descriptor.value as CinemaScenario
  }
  catch { throw new TypeError('cinema-input') }
}
function unavailable(): never { throw new RangeError('cinema-unqualified-result') }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
function retain<T>(rows: T[], row: T, count: number, cap: number) { if (rows.length >= count || bytes(row) > cap) unavailable(); rows.push(structuredClone(row)) }
function checkDomain(value: unknown, native = false): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > 1e6 || (!native && JSON.stringify(value).length > 32)) unavailable(); return }
  if (typeof value === 'string') { if (value.length > 256 || /[^ -~]/.test(value)) unavailable(); return }
  if (Array.isArray(value)) { if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1 || value.length > 50000) unavailable(); for (const item of value) checkDomain(item, native); return }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) unavailable()
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) { if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unavailable(); checkDomain(descriptor.value, native) }
}
function originQualified(context: MissionSimulationContext): boolean {
  const origin = context.estimate.localPosition?.origin
  return !!origin && origin.latitudeDeg === 0 && origin.longitudeDeg === 0 && origin.ellipsoidHeightM === 100
}
function poseAt(context: MissionSimulationContext): VehicleMeasurementPose | null {
  const n = context.nowMs, imu = context.sensors.sensors.find(s => s.kind === 'imu')?.observation
  const pose = predictVehicleMeasurementPose(context.estimate, imu, n)
  return pose && originQualified(context) && pose.positionCapturedAtMs <= n && n - pose.positionCapturedAtMs <= 200 && n - pose.attitudeCapturedAtMs <= 60 && n - pose.gyroCapturedAtMs <= 80 ? pose : null
}
/** One private mission instrument owns all angular tracking and shutter state. */
export function simulateCinema(input: unknown = {}): CinemaRun {
  const scenario = captureScenario(input)
  try { return runCinema(scenario) }
  catch { unavailable() }
}
function runCinema(scenario: CinemaScenario): CinemaRun {
  const model = cinemaModel(), position: SensorVector = scenario === 'mechanical-limit' ? [0.1, 4, -1.2] : [4, 0, -1.2]
  const selection: CinemaSelection = { id: 'selected-prop', revision: 1, source: 'synthetic-local-poi', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, reference, positionM: [...position] }
  const { plan, worstCaseMs } = validateMission({ version: 1, id: 'cinema-hover-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 12000, next: 'shot' }, { id: 'shot', kind: 'loiter', positionM: [0, 0, -1.2], durationMs: 10000, timeoutMs: 14000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 12000 }] })
  if (worstCaseMs !== 38000) unavailable()
  const gimbal = createCinemaGimbal(), renderImage = createCinemaRenderer(model, position)
  let actual: RigidBodyState | null = null, lastNow: number | null = null, encoder: CinemaEncoder | null = null, target: CinemaTarget | null = null
  let capturedImage: CinemaImage | null = null, capturedActual: CinemaActualCapture | null = null
  function exposureAtRequest(): { image: CinemaImage | null, actual: CinemaActualCapture | null } { return { image: capturedImage, actual: capturedActual } }
  const camera = createModeledCamera((body, nowMs) => {
    if (nowMs !== lastNow) unavailable()
    const joint = gimbal.current()
    capturedImage = renderImage(body, joint.positionRad)
    capturedActual = { bodyPositionM: [...body.positionM], bodyQuaternionWxyz: [...body.quaternionWxyz], jointPositionRad: [...joint.positionRad], appliedTorqueNm: [...joint.appliedTorqueNm] }
    return { rgba: Uint8Array.from(capturedImage.rgba), thermalCentiKelvin: null }
  }, { fault: scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none', faultAfterMs: 0 })
  const targets: CinemaTarget[] = [], encoders: CinemaEncoder[] = [], captures: CinemaCapture[] = []
  const counters = { trackingCommands: 0, shutterAttempts: 0, ackReceipts: 0, confirmedCaptures: 0, uncertainCaptures: 0, trackingCommandsAfterRetirement: 0, shutterAttemptsAfterRetirement: 0 }
  let loiter: number | null = null, latestStart: number | null = null, readySince: number | null = null, readyCount = 0, started: number | null = null, completed: number | null = null
  let firstFault: CinemaFault | null = null, retirement: CinemaRetirement | null = null, pending: CinemaCapture | null = null, invariantFailed = false
  let previousEncoder: CinemaEncoder | null = null, previousTarget: CinemaTarget | null = null, readyPreviousAt: number | null = null
  function retire(cause: CinemaRetirement['cause'], nowMs: number) {
    if (retirement) return
    if (!actual || lastNow !== nowMs) unavailable()
    retirement = { atMs: nowMs, cause, requestedTorqueNm: [0, 0, 0], bodyPositionM: [...actual.positionM], bodyQuaternionWxyz: [...actual.quaternionWxyz] }
    gimbal.retire(nowMs); camera.close()
    if (pending) { pending.state = 'uncertain'; pending.reason = firstFault?.code ?? 'capture-pending-at-retirement'; counters.uncertainCaptures++; pending = null }
  }
  function fault(code: CinemaFaultCode, nowMs: number): 'abort' {
    if (!firstFault) firstFault = { atMs: nowMs, code }
    retire('fault', nowMs)
    return 'abort'
  }
  function observe(context: MissionSimulationContext): 'abort' | undefined {
    const n = context.nowMs
    if (retirement) return undefined
    if (lastNow !== n || !encoder || !actual) unavailable()
    const priorRunning = context.mission.state === 'running', inLoiter = priorRunning && context.mission.taskId === 'shot', active = started !== null
    if (priorRunning && context.authority !== 'autonomous') return fault('authority-lost', n)
    if (inLoiter && loiter === null) { loiter = n; latestStart = Math.floor((n + 1600) / 40) * 40 }
    if (!active && latestStart !== null && n > latestStart) { retire('window-missed', n); return undefined }
    if (!priorRunning && context.mission.state !== 'ready') { retire('mission-terminal', n); return undefined }
    const pose = poseAt(context)
    if (vehicleReference(context.estimate) !== reference) { if (active || inLoiter) return fault('reference-changed', n); return undefined }
    if (!pose) { readySince = null; readyCount = 0; if (active) return fault('pose-unqualified', n); return undefined }
    if (!target || target.targetId !== selection.id || target.revision !== selection.revision || target.reference !== selection.reference || target.positionSigmaM !== 0.01 || target.clockUncertaintyMs !== 0 || target.capturedAtMs > n || target.receivedAtMs > n || target.receivedAtMs < target.capturedAtMs || target.positionM.some((v, i) => !Number.isFinite(v) || v !== selection.positionM[i]) || (previousTarget && (target.sequence < previousTarget.sequence || target.capturedAtMs < previousTarget.capturedAtMs || target.sequence === previousTarget.sequence && JSON.stringify(target) !== JSON.stringify(previousTarget) || target.sequence > previousTarget.sequence && target.capturedAtMs <= previousTarget.capturedAtMs))) return fault('target-unqualified', n)
    if (n - target.capturedAtMs > 100) return fault('target-stale', n)
    const targetNew = !previousTarget || target.sequence > previousTarget.sequence
    const encoderNew = !previousEncoder || encoder.sequence === previousEncoder.sequence + 1 && encoder.capturedAtMs === previousEncoder.capturedAtMs + 20 && encoder.receivedAtMs === previousEncoder.receivedAtMs + 20
    const encoderValid = encoderNew && encoder.receivedAtMs === n && encoder.capturedAtMs === n - 20 && encoder.positionRad.every(Number.isFinite) && encoder.velocityRadS !== null && encoder.velocityRadS.every(Number.isFinite)
    previousTarget = structuredClone(target); previousEncoder = structuredClone(encoder)
    if (encoder.limitSwitch || !withinCinemaTravel(encoder.positionRad)) { if (active || inLoiter) return fault('joint-limit', n); return undefined }
    if (!encoderValid) { readySince = null; readyCount = 0; if (active) return fault('encoder-unqualified', n); return undefined }
    const velocity = context.estimate.localPosition!.velocityMps
    const settledVehicle = Math.hypot(...velocity) <= 0.15 && Math.hypot(pose.positionM[0], pose.positionM[1], pose.positionM[2] + 1.2) <= 0.15
    if (active && (!inLoiter || !settledVehicle)) return fault('active-loiter-lost', n)
    if (!inLoiter) { readySince = null; readyCount = 0; return undefined }
    const offset = started === null ? 0 : cinemaOffset(n - started)
    const goal = cinemaGoal(pose.positionM, pose.quaternionWxyz, target.positionM, offset)
    if (!goal) return fault('pose-unqualified', n)
    if (!withinCinemaTravel(goal)) return fault('joint-goal-limit', n)
    if (started === null) {
      const ready = settledVehicle && targetNew && encoder.positionRad.every((v, i) => Math.abs(v - goal[i]!) <= 0.5 * Math.PI / 180) && encoder.velocityRadS!.every(v => Math.abs(v) <= 0.05)
      if (!ready) { readySince = null; readyCount = 0 }
      else { if (readySince === null || readyPreviousAt !== n - 20) { readySince = n; readyCount = 1 } else readyCount = Math.min(26, readyCount + 1) }
      readyPreviousAt = n
      if (readyCount === 26 && n % 40 === 0 && n <= latestStart! && !pending) started = n
    }
    // Higher-priority context, target and encoder failures above win over an ACK at the same epoch.
    if (pending) {
      const ack = camera.poll(n)
      if (ack) {
        counters.ackReceipts++
        if (ack.reference !== reference && ack.reference !== 'wrong-reference') unavailable()
        pending.ack = { sessionId: ack.sessionId, sequence: ack.sequence, reference: ack.reference, issuedAtMs: ack.issuedAtMs, capturedAtMs: ack.capturedAtMs, acknowledgedAtMs: ack.acknowledgedAtMs, receivedAtMs: n }
        const valid = ack.sessionId === pending.sessionId && ack.sequence === pending.sequence && ack.reference === pending.reference && ack.issuedAtMs === pending.issuedAtMs && ack.capturedAtMs === pending.issuedAtMs && ack.issuedAtMs <= ack.acknowledgedAtMs && ack.acknowledgedAtMs <= n && n <= pending.deadlineMs && ack.acknowledgedAtMs <= pending.deadlineMs && pending.image !== null && pending.image.width === 64 && pending.image.height === 48 && ack.rgba.length === 12288 && ack.thermalCentiKelvin === null && ack.rgba.every((v, i) => v === pending!.image!.rgba[i])
        if (!valid) return fault('ack-scope', n)
        pending.state = 'confirmed'; pending.reason = 'acknowledged'; counters.confirmedCaptures++; pending = null
      }
      else if (n >= pending.deadlineMs) return fault('ack-deadline', n)
    }
    if (started !== null && n === started + 8000) {
      if (captures.length !== 3 || counters.confirmedCaptures !== 3 || pending) return fault('capture-missing', n)
      completed = n; retire('shot-completed', n); return undefined
    }
    if (retirement) { counters.trackingCommandsAfterRetirement++; unavailable() }
    gimbal.command(goal, encoder, n); counters.trackingCommands++
    if (started !== null) {
      const relative = n - started
      if (relative === 1000 || relative === 3000 || relative === 7000) {
        if (pending || captures.length >= 3) unavailable()
        if (retirement) { counters.shutterAttemptsAfterRetirement++; unavailable() }
        const capture: CinemaCapture = { sequence: (captures.length + 1) as 1 | 2 | 3, state: 'uncertain', reason: 'capture-pending-at-retirement', sessionId: 'cinema-hover-v1', reference, targetId: 'selected-prop', targetRevision: 1, shotOffsetMs: relative, issuedAtMs: n, capturedAtMs: null, deadlineMs: n + 80, calibrationId: 'synthetic-cinema-forward-v1', exposureLabelUs: 1000, pose: structuredClone(pose), encoder: structuredClone(encoder), actual: null, image: null, ack: null, postStepAdmission: 'valid', quality: cinemaImageQuality(null, offset) }
        captures.push(capture); pending = capture; counters.shutterAttempts++; capturedImage = null; capturedActual = null
        try {
          camera.request({ sessionId: capture.sessionId, sequence: capture.sequence, issuedAtMs: n, reference })
          const exposed = exposureAtRequest()
          if (!exposed.image || !exposed.actual) unavailable()
          capture.capturedAtMs = n; capture.actual = structuredClone(exposed.actual); capture.image = structuredClone(exposed.image); capture.quality = cinemaImageQuality(capture.image, offset)
        }
        catch { return fault('shutter-failed', n) }
      }
    }
    return undefined
  }
  const result = simulateMission({ plan, scenario: scenario === 'rc-override' ? 'rc-override' : 'nominal', seconds: 45, instrument: {
    disturbance(nowMs) {
      if (scenario !== 'body-disturbance' || started === null || retirement) return {}
      const r = nowMs - started - 400
      if (r < 0 || r >= 6000) return {}
      const e = Math.sin(Math.PI * r / 6000) ** 2
      return { torqueNm: [0.0005 * e * Math.sin(2 * Math.PI * r / 1000), 0.0004 * e * Math.sin(2 * Math.PI * r / 1400), 0] }
    },
    render(state, nowMs) {
      if (retirement) return
      try {
        encoder = gimbal.render(nowMs); actual = structuredClone(state); lastNow = nowMs; retain(encoders, encoder, 2251, 512)
        if (!(scenario === 'target-loss' && started !== null && nowMs > started + 900)) {
          target = { sequence: targets.length + 1, capturedAtMs: nowMs, receivedAtMs: nowMs, targetId: 'selected-prop', revision: 1, reference, positionM: [...position], positionSigmaM: 0.01, clockUncertaintyMs: 0 }; retain(targets, target, 2251, 640)
        }
        camera.render(state, nowMs)
      }
      catch { invariantFailed = true; unavailable() }
    },
    observe(context) { try { return observe(context) } catch { invariantFailed = true; unavailable() } },
  } })
  if (invariantFailed || lastNow === null || !actual) { if (!retirement) camera.close(); unavailable() }
  if (!retirement) {
    if (lastNow === 45000 && ['running', 'paused'].includes(result.mission.state)) {
      if (started !== null) fault('horizon-exhausted', lastNow)
      else retire('horizon-exhausted', lastNow)
    }
    else retire('mission-terminal', lastNow)
  }
  const tail = gimbal.tail()
  const reconciliation = { invalidCaptureSequences: [] as number[], earliestInvalidAtMs: null as number | null }
  const rows = new Map(result.trace.rows.map(row => [row.observation.nowMs, row]))
  const admitted = (atMs: number) => {
    const row = rows.get(atMs), o = row?.observation
    return !!row && !!o && o.healthy && o.authority === 'autonomous' && o.reference === reference && o.origin.latitudeDeg === 0 && o.origin.longitudeDeg === 0 && o.origin.ellipsoidHeightM === 100 && row.result.state === 'running' && row.result.taskId === 'shot'
  }
  let startAdmission = true
  if (started !== null) {
    const entry = result.trace.rows.find(row => row.result.state === 'running' && row.result.taskId === 'shot')
    startAdmission = loiter !== null && entry?.observation.nowMs === loiter - 20 && latestStart === Math.floor((loiter + 1600) / 40) * 40 && started <= latestStart && admitted(started)
  }
  for (const capture of captures) {
    const invalid = [capture.issuedAtMs, ...(capture.ack ? [capture.ack.receivedAtMs] : [])].filter(n => !admitted(n))
    if (invalid.length || !startAdmission) {
      capture.postStepAdmission = 'invalid'; reconciliation.invalidCaptureSequences.push(capture.sequence)
      const first = Math.min(...(invalid.length ? invalid : [started!]))
      reconciliation.earliestInvalidAtMs = reconciliation.earliestInvalidAtMs === null ? first : Math.min(first, reconciliation.earliestInvalidAtMs)
      if (capture.state === 'confirmed') { capture.state = 'uncertain'; capture.reason = 'mission-step-rejected'; counters.confirmedCaptures--; counters.uncertainCaptures++ }
    }
  }
  const motion = evaluateCinemaMotion(gimbal.rows, tail)
  const opticalErrors = captures.flatMap(c => c.quality.errorPx === null ? [] : [c.quality.errorPx])
  const frames = { exposed: captures.filter(c => c.image !== null).length, confirmed: captures.filter(c => c.state === 'confirmed').length, qualified: captures.filter(c => c.state === 'confirmed' && c.postStepAdmission === 'valid' && c.quality.qualified).length, maxErrorPx: opticalErrors.length ? Math.max(...opticalErrors) : null }
  const neutral = result.board.motorsN.every(n => n === 0)
  let status: CinemaRun['status'] = 'completed', reason: CinemaReason = 'qualified'
  const retainedFault = (() : CinemaFault | null => firstFault)()
  const retainedRetirement = (() : CinemaRetirement | null => retirement)()
  if (!retainedRetirement) unavailable()
  if (retainedFault) { status = 'halted'; reason = retainedFault.code }
  else if (!startAdmission || reconciliation.invalidCaptureSequences.length) { status = 'failed'; reason = 'admission-reconciliation' }
  else if (started === null) { status = 'incomplete'; reason = retainedRetirement.cause === 'window-missed' ? 'readiness-window-missed' : 'shot-incomplete' }
  else if (completed === null) { status = 'incomplete'; reason = 'shot-incomplete' }
  else if (result.mission.state !== 'completed' || result.mission.reason !== 'landed') { status = 'failed'; reason = 'mission-not-completed' }
  else if (!neutral) { status = 'failed'; reason = 'mission-nonneutral' }
  else if (!motion.withinDynamicBounds || !motion.withinMechanicalBounds) { status = 'failed'; reason = 'motion-bounds' }
  else if (captures.length !== 3 || frames.confirmed !== 3 || frames.qualified !== 3) { status = 'failed'; reason = 'frame-quality' }
  const run: CinemaRun = {
    version: 1, evidence: 'owned-cinema-hover-reframe-simulation', profile: 'hover-poi-reframe-v1', scenario, status, reason, physicalFlightEnabled: false, physicalGimbalActuationEnabled: false, identityAuthenticated: false, selection, model,
    mission: { trace: result.trace, terminalState: result.mission.state, terminalReason: result.mission.reason, boardMotorsN: [...result.board.motorsN], boardFault: result.board.fault, boardNeutral: neutral, finalTruthPositionM: [...result.finalTruthPositionM] },
    shot: { phase: firstFault ? 'fault' : completed !== null ? 'completed' : started !== null || retainedRetirement.cause === 'window-missed' ? 'incomplete' : 'not-started', loiterObservedAtMs: loiter, latestStartMs: latestStart, readySinceMs: readySince, readySampleCount: readyCount, startedAtMs: started, completedAtMs: completed, reference: started === null ? null : reference, firstFault: retainedFault, retirement: retainedRetirement, counters },
    gimbal: { rows: gimbal.rows, tail }, targetObservations: targets, encoderObservations: encoders, captures, reconciliation, evaluation: { motion, frames, qualified: status === 'completed' },
  }
  checkDomain(run)
  if (run.mission.trace.rows.length > 6001 || bytes(run.mission.trace) + 1 > 8388608 || bytes(model) > 16384 || bytes(run) + 1 > 20971520) unavailable()
  for (const row of [...run.gimbal.rows, ...run.gimbal.tail]) if (bytes(row) > 768) unavailable()
  for (const capture of captures) if (bytes(capture) > 65536 || capture.image && (capture.image.rgba.length !== 12288 || !capture.image.rgba.every(n => Number.isInteger(n) && n >= 0 && n <= 255) || bytes(capture.image.rgba) > 49154)) unavailable()
  const { mission, ...cinema } = run
  const metadata = { ...mission, trace: null }
  const separators = Math.max(0, gimbal.rows.length - 1) + tail.length - 1 + Math.max(0, targets.length - 1) + Math.max(0, encoders.length - 1) + Math.max(0, captures.length - 1) + 1
  const quaternionValid = (q: number[]) => q.length === 4 && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) <= 1e-6
  if (!quaternionValid(run.shot.retirement.bodyQuaternionWxyz) || captures.some(c => !quaternionValid(c.pose.quaternionWxyz) || c.actual && !quaternionValid(c.actual.bodyQuaternionWxyz))) unavailable()
  const nativeCode = (code: string) => /^[a-z][a-z0-9-]{0,95}$/.test(code)
  if (!nativeCode(mission.terminalReason) || mission.boardFault !== null && !nativeCode(mission.boardFault) || mission.trace.rows.some(r => !nativeCode(r.result.reason) || r.observation.nowMs > 45000)) unavailable()
  if (separators > 32768 || bytes({ ...cinema, mission: metadata }) + 1 > 12582912 || bytes({ selection, shot: run.shot, evaluation: run.evaluation, reconciliation, mission: { ...mission, trace: null } }) > 32768) unavailable()
  if (counters.trackingCommandsAfterRetirement !== 0 || counters.shutterAttemptsAfterRetirement !== 0) unavailable()
  return run
}
