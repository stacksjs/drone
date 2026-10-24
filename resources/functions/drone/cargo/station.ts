import type { IntakeParcel } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import { multirotorModel } from '../controls/model'

interface StationDeclaration {
  atMs: number
  parcel: IntakeParcel
  pickup: { centerM: SensorVector, radiusM: number }
  destinationM: SensorVector
  maxSpeedMps: number
  maxAccelerationMps2: number
}
export interface CargoStationSnapshot {
  evidence: 'modeled-cargo-station-v1'
  physicalActuationEnabled: false
  phase: 'falling' | 'held' | 'missed' | 'moving' | 'braking' | 'cancelled' | 'ready' | 'departed'
  atMs: number
  startedAtMs: number | null
  durationMs: number | null
  cancelRequestedAtMs: number | null
  stoppedAtMs: number | null
  ownedMassKg: number
  parcel: IntakeParcel | null
  forceN: SensorVector
  impact: { atMs: number, positionM: SensorVector, velocityBeforeMps: SensorVector, impulseNs: SensorVector, dissipationJ: number } | null
  energy: { initialJ: number, currentJ: number, departedJ: number, stationNetWorkJ: number, positiveWorkJ: number, negativeWorkJ: number, planeDissipationJ: number, residualJ: number }
}
function record(input: unknown, names: string[]) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== names.length) throw new TypeError()
  const captured: Record<string, unknown> = {}
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(input, name)
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError()
    captured[name] = d.value
  }
  return captured
}
function vector(input: unknown, min: number, max: number): SensorVector {
  if (!Array.isArray(input) || input.length !== 3 || Reflect.ownKeys(input).length !== 4) throw new TypeError()
  const captured: number[] = []
  for (let i = 0; i < 3; i++) {
    const d = Object.getOwnPropertyDescriptor(input, String(i))
    if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'number' || !Number.isFinite(d.value) || d.value < min || d.value > max) throw new TypeError()
    captured.push(d.value)
  }
  return captured as SensorVector
}
const within = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const distance = (a: SensorVector, b: SensorVector) => Math.hypot(...a.map((n, i) => n - b[i]!))
function durationMs(lengthM: number, speed: number, acceleration: number) {
  // Peak derivatives of 10u^3 - 15u^4 + 6u^5 are 15/8 and 10/sqrt(3).
  return Math.ceil(1000 * Math.max(.5, 1.875 * lengthM / speed, Math.sqrt(10 / Math.sqrt(3) * lengthM / acceleration)) / 8) * 8
}
function capture(input: unknown): StationDeclaration {
  try {
    const v = record(input, ['atMs', 'parcel', 'pickup', 'destinationM', 'maxSpeedMps', 'maxAccelerationMps2'])
    const p = record(v.parcel, ['id', 'massKg', 'positionM', 'velocityMps']), pickup = record(v.pickup, ['centerM', 'radiusM'])
    if (!Number.isSafeInteger(v.atMs) || !within(v.atMs, 0, Number.MAX_SAFE_INTEGER - 180000) || v.atMs % 4 !== 0
      || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || !within(p.massKg, Number.MIN_VALUE, .25)
      || !within(pickup.radiusM, .05, 2) || !within(v.maxSpeedMps, .05, 1) || !within(v.maxAccelerationMps2, .05, 2)) throw new TypeError()
    const positionM = vector(p.positionM, -1000, 1000), velocityMps = vector(p.velocityMps, -5, 5), centerM = vector(pickup.centerM, -1000, 1000), destinationM = vector(v.destinationM, -1000, 1000)
    if (!within(centerM[2], -1, 0) || !within(positionM[2], centerM[2] - 3, centerM[2]) || destinationM[2] < centerM[2] - 1 || destinationM[2] > centerM[2]
      || distance(centerM, destinationM) + pickup.radiusM > 20
      || durationMs(distance(centerM, destinationM) + pickup.radiusM, v.maxSpeedMps, v.maxAccelerationMps2) > 120000) throw new TypeError()
    return { atMs: v.atMs, parcel: { id: p.id, massKg: p.massKg, positionM, velocityMps }, pickup: { centerM, radiusM: pickup.radiusM }, destinationM, maxSpeedMps: v.maxSpeedMps, maxAccelerationMps2: v.maxAccelerationMps2 }
  }
  catch { throw new TypeError('cargo-station-constructor') }
}

/** One point parcel on a prescribed, finite powered station rail. No hardware IO or custody ACK. */
export function createCargoStationHandler(input: unknown) {
  const config = capture(input), gravity = multirotorModel.gravityMps2
  let parcel: IntakeParcel | null = config.parcel, phase: CargoStationSnapshot['phase'] = 'falling', nowMs = config.atMs
  let startedAtMs: number | null = null, motionMs: number | null = null, fromM: SensorVector | null = null
  let cancelRequestedAtMs: number | null = null, stoppedAtMs: number | null = null
  let brake: { atMs: number, positionM: SensorVector, velocityMps: SensorVector, speedMps: number } | null = null
  let forceN: SensorVector = [0, 0, 0], impact: CargoStationSnapshot['impact'] = null
  const mechanical = (p: IntakeParcel) => .5 * p.massKg * p.velocityMps.reduce((sum, n) => sum + n * n, 0) - p.massKg * gravity * p.positionM[2]
  const initialJ = mechanical(parcel)
  let departedJ = 0, stationNetWorkJ = 0, positiveWorkJ = 0, negativeWorkJ = 0, planeDissipationJ = 0
  function capturePlane(atMs: number) {
    const p = parcel!, before = [...p.velocityMps] as SensorVector
    const dissipationJ = .5 * p.massKg * before.reduce((sum, n) => sum + n * n, 0)
    p.positionM[2] = config.pickup.centerM[2]
    impact = { atMs, positionM: [...p.positionM], velocityBeforeMps: before, impulseNs: before.map(n => -p.massKg * n) as SensorVector, dissipationJ }
    planeDissipationJ += dissipationJ
    p.velocityMps = [0, 0, 0]; forceN = [0, 0, -p.massKg * gravity]
    phase = cancelRequestedAtMs !== null ? 'cancelled' : Math.hypot(p.positionM[0] - config.pickup.centerM[0], p.positionM[1] - config.pickup.centerM[1]) <= config.pickup.radiusM ? 'held' : 'missed'
    if (cancelRequestedAtMs !== null) stoppedAtMs = atMs
  }
  if (parcel.positionM[2] === config.pickup.centerM[2] && parcel.velocityMps[2] >= 0) capturePlane(nowMs)
  function retainWork(beforeJ: number) {
    const work = mechanical(parcel!) - beforeJ
    stationNetWorkJ += work; positiveWorkJ += Math.max(0, work); negativeWorkJ += Math.min(0, work)
  }
  function snapshot(): CargoStationSnapshot {
    const currentJ = parcel ? mechanical(parcel) : 0
    return structuredClone({ evidence: 'modeled-cargo-station-v1', physicalActuationEnabled: false, phase, atMs: nowMs, startedAtMs, durationMs: motionMs, cancelRequestedAtMs, stoppedAtMs, parcel,
      ownedMassKg: parcel?.massKg ?? 0, forceN, impact, energy: { initialJ, currentJ, departedJ, stationNetWorkJ, positiveWorkJ, negativeWorkJ, planeDissipationJ, residualJ: currentJ + departedJ + planeDissipationJ - initialJ - stationNetWorkJ } })
  }
  return {
    snapshot,
    start(...args: unknown[]): { outcome: 'started', atMs: number, durationMs: number } | { outcome: 'refused', reason: 'not-held' | 'deadline' } {
      if (args.length) throw new TypeError('cargo-station-arguments')
      if (phase !== 'held') return { outcome: 'refused', reason: 'not-held' }
      const duration = durationMs(distance(parcel!.positionM, config.destinationM), config.maxSpeedMps, config.maxAccelerationMps2)
      if (nowMs - config.atMs + duration > 180000) return { outcome: 'refused', reason: 'deadline' }
      fromM = [...parcel!.positionM]; motionMs = duration; startedAtMs = nowMs; phase = 'moving'
      return { outcome: 'started', atMs: nowMs, durationMs: duration }
    },
    cancel(...args: unknown[]): { outcome: 'cancelling' | 'cancelled', atMs: number } | { outcome: 'refused', reason: 'already-cancelled' | 'departed' } {
      if (args.length) throw new TypeError('cargo-station-arguments')
      if (phase === 'departed') return { outcome: 'refused', reason: 'departed' }
      if (cancelRequestedAtMs !== null) return { outcome: 'refused', reason: 'already-cancelled' }
      cancelRequestedAtMs = nowMs
      const speedMps = Math.hypot(...parcel!.velocityMps)
      if (phase === 'moving' && speedMps > 0) {
        brake = { atMs: nowMs, positionM: [...parcel!.positionM], velocityMps: [...parcel!.velocityMps], speedMps }
        phase = 'braking'
      }
      else if (phase !== 'falling') { phase = 'cancelled'; stoppedAtMs = nowMs }
      return { outcome: phase === 'cancelled' ? 'cancelled' : 'cancelling', atMs: nowMs }
    },
    step(atMs: number, ...extra: unknown[]) {
      if (extra.length || !Number.isSafeInteger(atMs) || atMs !== nowMs + 4 || atMs - config.atMs > 180000) throw new TypeError('cargo-station-clock')
      if (phase === 'falling') {
        const p = parcel!, down = p.positionM[2] - config.pickup.centerM[2], vz = p.velocityMps[2]
        const speedAtPlane = Math.sqrt(vz * vz - 2 * gravity * down)
        // Stable positive root for downward motion, including a point already at the plane.
        const hitSeconds = vz >= 0 ? (down === 0 ? 0 : -2 * down / (vz + speedAtPlane)) : (-vz + speedAtPlane) / gravity
        const seconds = Math.min(.004, hitSeconds)
        p.positionM = p.positionM.map((n, i) => n + p.velocityMps[i]! * seconds + (i === 2 ? .5 * gravity * seconds ** 2 : 0)) as SensorVector
        p.velocityMps[2] += gravity * seconds
        if (hitSeconds <= .004) capturePlane(nowMs + hitSeconds * 1000)
      }
      else if (phase === 'braking') {
        const b = brake!, p = parcel!, beforeJ = mechanical(p), stopSeconds = b.speedMps / config.maxAccelerationMps2
        const seconds = Math.min((atMs - b.atMs) / 1000, stopSeconds), fraction = Math.max(0, 1 - seconds / stopSeconds)
        p.positionM = b.positionM.map((n, i) => n + b.velocityMps[i]! * (seconds - .5 * seconds ** 2 / stopSeconds)) as SensorVector
        p.velocityMps = b.velocityMps.map(n => n * fraction) as SensorVector
        forceN = b.velocityMps.map((n, i) => p.massKg * (-n / stopSeconds - (i === 2 ? gravity : 0))) as SensorVector
        retainWork(beforeJ)
        if (seconds === stopSeconds) { phase = 'cancelled'; stoppedAtMs = b.atMs + stopSeconds * 1000; forceN = [0, 0, -p.massKg * gravity] }
      }
      else if (phase === 'moving') {
        const beforeJ = mechanical(parcel!), seconds = motionMs! / 1000, u = Math.min(1, (atMs - startedAtMs!) / motionMs!)
        const s = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5, ds = 30 * u ** 2 * (1 - u) ** 2, dds = 60 * u * (1 - u) * (1 - 2 * u)
        const delta = config.destinationM.map((n, i) => n - fromM![i]!) as SensorVector
        parcel!.positionM = u === 1 ? [...config.destinationM] : fromM!.map((n, i) => n + delta[i]! * s) as SensorVector
        parcel!.velocityMps = delta.map(n => n * ds / seconds) as SensorVector
        forceN = delta.map((n, i) => parcel!.massKg * (n * dds / seconds ** 2 - (i === 2 ? gravity : 0))) as SensorVector
        retainWork(beforeJ)
        if (u === 1) phase = 'ready'
      }
      nowMs = atMs
      return snapshot()
    },
    takeReadyParcel(...args: unknown[]): { outcome: 'departed', atMs: number, parcel: IntakeParcel } | { outcome: 'refused', reason: 'not-ready' } {
      if (args.length) throw new TypeError('cargo-station-arguments')
      if (phase !== 'ready') return { outcome: 'refused', reason: 'not-ready' }
      const outgoing = structuredClone(parcel!)
      departedJ = mechanical(parcel!); parcel = null; phase = 'departed'; forceN = [0, 0, 0]
      return { outcome: 'departed', atMs: nowMs, parcel: outgoing }
    },
  }
}
