import type { SensorVector } from '../sensors/types'
import type { Quaternion } from '../estimation/frames'
import type { Motors } from './model'
import { multiplyQuaternion, normalizeQuaternion, rotateBodyToNed, rotateNedToBody } from '../estimation/frames'
import { multirotorModel as model, validVector } from './model'
import { quadXWrench } from './allocation'
export { rotateBodyToNed, rotateNedToBody } from '../estimation/frames'
interface RigidBodyInput { positionM?: SensorVector, motorsN?: Motors, groundDownM?: number, groundGradient?: [number, number] }
interface CarriedPointLoad { id: string, massKg: number, forwardM: number }
interface BodySnapshot { positionM: SensorVector, velocityMps: SensorVector, angularRateRadS: SensorVector, accelerationMps2: SensorVector, quaternionWxyz: Quaternion, motorsN: Motors, groundContact: boolean }
interface LoadProperties { id: string, phase: 'attached' | 'separated', pointMassKg: number, forwardM: number, totalMassKg: number, cgBodyM: SensorVector, inertiaDiagonalKgM2: SensorVector }
interface LoadSnapshot { properties: LoadProperties, centerPositionM: SensorVector, centerVelocityMps: SensorVector }
interface SeparationSide { properties: LoadProperties, bodyPositionM: SensorVector, bodyVelocityMps: SensorVector, quaternionWxyz: Quaternion, angularRateRadS: SensorVector, actualMotorsN: Motors, centerPositionM: SensorVector, centerVelocityMps: SensorVector }
type LoadSeparation = { outcome: 'separated', reason: 'prescribed-zero-ejection', before: SeparationSide, after: SeparationSide, parcel: { massKg: number, positionM: SensorVector, velocityMps: SensorVector } } | { outcome: 'refused', reason: 'already-separated' }
interface RigidBody { snapshot(): BodySnapshot, step(command: Motors, dtS: number, disturbance?: { windMps?: SensorVector, forceN?: SensorVector, torqueNm?: SensorVector }): BodySnapshot }
interface LoadedRigidBody extends RigidBody { loadSnapshot(): LoadSnapshot, separateCarriedLoad(): LoadSeparation }
function cargoCross(a: SensorVector, b: SensorVector): SensorVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
/** New opt-in records are captured as exact own data. The absent-own-member path is deliberately legacy. */
function captureCarriedPointLoad(input: unknown): { input: RigidBodyInput, load: CarriedPointLoad } | null {
  try {
    if (!input || (typeof input !== 'object' && typeof input !== 'function') || !Object.getOwnPropertyDescriptor(input, 'carriedPointLoad')) return null
    function record(value: unknown, allowed: string[], required: string[]) {
      if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError()
      const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(value)
      if (names.some(name => typeof name !== 'string' || !allowed.includes(name)) || required.some(name => !Object.hasOwn(descriptors, name))) throw new TypeError()
      const captured: Record<string, unknown> = {}
      for (const name of names as string[]) {
        const descriptor = descriptors[name]!
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) throw new TypeError()
        captured[name] = descriptor.value
      }
      return captured
    }
    function tuple(value: unknown, length: number, min: number, max: number) {
      if (!Array.isArray(value) || value.length !== length || Reflect.ownKeys(value).length !== length + 1) throw new TypeError()
      const captured: number[] = []
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value) || descriptor.value < min || descriptor.value > max) throw new TypeError()
        captured.push(descriptor.value)
      }
      return captured
    }
    const captured = record(input, ['positionM', 'motorsN', 'groundDownM', 'groundGradient', 'carriedPointLoad'], ['carriedPointLoad'])
    const load = record(captured.carriedPointLoad, ['id', 'massKg', 'forwardM'], ['id', 'massKg', 'forwardM'])
    if (typeof load.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(load.id) || typeof load.massKg !== 'number' || !Number.isFinite(load.massKg) || load.massKg <= 0 || load.massKg > 0.25 || typeof load.forwardM !== 'number' || !Number.isFinite(load.forwardM) || load.forwardM < -0.1 || load.forwardM > 0.1) throw new TypeError()
    const body: RigidBodyInput = {}
    if (Object.hasOwn(captured, 'positionM')) body.positionM = tuple(captured.positionM, 3, -1e6, 1e6) as SensorVector
    if (Object.hasOwn(captured, 'motorsN')) body.motorsN = tuple(captured.motorsN, 4, 0, model.maxMotorThrustN) as Motors
    if (Object.hasOwn(captured, 'groundDownM')) {
      if (typeof captured.groundDownM !== 'number' || !Number.isFinite(captured.groundDownM) || captured.groundDownM < -1 || captured.groundDownM > 0) throw new TypeError()
      body.groundDownM = captured.groundDownM
    }
    if (Object.hasOwn(captured, 'groundGradient')) {
      body.groundGradient = tuple(captured.groundGradient, 2, -0.1, 0.1) as [number, number]
      if (Math.hypot(...body.groundGradient) > 0.1) throw new TypeError()
    }
    return { input: body, load: { id: load.id, massKg: load.massKg, forwardM: load.forwardM } }
  }
  catch { throw new TypeError('cargo-load-constructor') }
}
export function createRigidBody(input: RigidBodyInput & { carriedPointLoad: CarriedPointLoad }): LoadedRigidBody
export function createRigidBody(input?: RigidBodyInput): RigidBody
export function createRigidBody(input: RigidBodyInput & { carriedPointLoad?: CarriedPointLoad } = {}): RigidBody | LoadedRigidBody {
  const configured = captureCarriedPointLoad(input)
  if (configured) input = configured.input

  const groundDownM = input.groundDownM ?? 0
  const groundGradient = [...(input.groundGradient ?? [0, 0])]
  if (!Array.isArray(groundGradient) || groundGradient.length !== 2 || !groundGradient.every(Number.isFinite) || Math.hypot(...groundGradient) > 0.1) throw new RangeError('Invalid modeled ground gradient')
  if (!Number.isFinite(groundDownM) || groundDownM < -1 || groundDownM > 0) throw new RangeError('Invalid modeled ground contact plane')
  let positionM = [...(input.positionM ?? [0, 0, -1])] as SensorVector
  let motorsN = [...(input.motorsN ?? [0, 0, 0, 0])] as Motors
  if (!validVector(positionM)) throw new RangeError('Invalid physics initial position')
  quadXWrench(motorsN)
  let velocityMps: SensorVector = [0, 0, 0], angularRateRadS: SensorVector = [0, 0, 0], accelerationMps2: SensorVector = [0, 0, 0]
  let quaternionWxyz: Quaternion = [1, 0, 0, 0], groundContact = false
  function snapshot() { return structuredClone({ positionM, velocityMps, angularRateRadS, accelerationMps2, quaternionWxyz, motorsN, groundContact }) }
  let attached = true
  function properties(): LoadProperties {
    const load = configured!.load, totalMassKg = attached ? model.massKg + load.massKg : model.massKg
    const shift = attached ? model.massKg * load.massKg / totalMassKg * load.forwardM ** 2 : 0
    return { id: load.id, phase: attached ? 'attached' : 'separated', pointMassKg: load.massKg, forwardM: load.forwardM, totalMassKg, cgBodyM: [attached ? load.massKg * load.forwardM / totalMassKg : 0, 0, 0], inertiaDiagonalKgM2: [model.inertiaKgM2[0]!, model.inertiaKgM2[1]! + shift, model.inertiaKgM2[2]! + shift] }
  }
  let centerPositionM: SensorVector | null = configured ? positionM.map((n, i) => n + properties().cgBodyM[i]!) as SensorVector : null
  let centerVelocityMps: SensorVector | null = configured ? [...velocityMps] : null
  const body = {
    snapshot,
    step(command: Motors, dtS: number, disturbance: { windMps?: SensorVector, forceN?: SensorVector, torqueNm?: SensorVector } = {}) {
      quadXWrench(command)
      const wind = disturbance.windMps ?? [0, 0, 0], force = disturbance.forceN ?? [0, 0, 0], torque = disturbance.torqueNm ?? [0, 0, 0]
      if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 0.01 || ![wind, force, torque].every(validVector)) throw new RangeError('Invalid physics step or disturbance')
      motorsN = motorsN.map((n, i) => n + (command[i]! - n) * (1 - Math.exp(-dtS / model.motorTimeConstantS))) as Motors
      const wrench = quadXWrench(motorsN)
      let alpha: SensorVector | null = null
      if (configured) {
        const load = properties(), inertia = load.inertiaDiagonalKgM2
        const momentum = angularRateRadS.map((n, i) => n * inertia[i]!) as SensorVector
        const gyroscopic = cargoCross(angularRateRadS, momentum), shift = cargoCross(load.cgBodyM, [0, 0, -wrench.thrustN])
        alpha = angularRateRadS.map((n, i) => (wrench.torqueNm[i]! - shift[i]! + torque[i]! - gyroscopic[i]! - model.angularDragNms * n) / inertia[i]!) as SensorVector
        angularRateRadS = angularRateRadS.map((n, i) => n + dtS * alpha![i]!) as SensorVector
      }
      else {
        const momentum = angularRateRadS.map((n, i) => n * model.inertiaKgM2[i]!)
        const cross = [angularRateRadS[1] * momentum[2]! - angularRateRadS[2] * momentum[1]!, angularRateRadS[2] * momentum[0]! - angularRateRadS[0] * momentum[2]!, angularRateRadS[0] * momentum[1]! - angularRateRadS[1] * momentum[0]!]
        angularRateRadS = angularRateRadS.map((n, i) => n + dtS * (wrench.torqueNm[i]! + torque[i]! - cross[i]! - model.angularDragNms * n) / model.inertiaKgM2[i]!) as SensorVector
      }
      const angle = Math.hypot(...angularRateRadS) * dtS, scale = angle < 1e-10 ? dtS / 2 : Math.sin(angle / 2) * dtS / angle
      quaternionWxyz = normalizeQuaternion(multiplyQuaternion(quaternionWxyz, [Math.cos(angle / 2), angularRateRadS[0] * scale, angularRateRadS[1] * scale, angularRateRadS[2] * scale]))
      const thrust = rotateBodyToNed(quaternionWxyz, [0, 0, -wrench.thrustN])
      if (configured) {
        const load = properties(), c = load.cgBodyM
        const centerAcceleration = thrust.map((n, i) => (n + force[i]! - model.linearDragKgPerS * (centerVelocityMps![i]! - wind[i]!)) / load.totalMassKg + (i === 2 ? model.gravityMps2 : 0)) as SensorVector
        centerVelocityMps = centerVelocityMps!.map((n, i) => n + centerAcceleration[i]! * dtS) as SensorVector
        centerPositionM = centerPositionM!.map((n, i) => n + centerVelocityMps![i]! * dtS) as SensorVector
        const positionLever = rotateBodyToNed(quaternionWxyz, c), velocityLever = rotateBodyToNed(quaternionWxyz, cargoCross(angularRateRadS, c))
        const tangential = cargoCross(alpha!, c), centripetal = cargoCross(angularRateRadS, cargoCross(angularRateRadS, c))
        const accelerationLever = rotateBodyToNed(quaternionWxyz, tangential.map((n, i) => n + centripetal[i]!) as SensorVector)
        positionM = centerPositionM.map((n, i) => n - positionLever[i]!) as SensorVector
        velocityMps = centerVelocityMps.map((n, i) => n - velocityLever[i]!) as SensorVector
        accelerationMps2 = centerAcceleration.map((n, i) => n - accelerationLever[i]!) as SensorVector
      }
      else {
        accelerationMps2 = thrust.map((n, i) => (n + force[i]! - model.linearDragKgPerS * (velocityMps[i]! - wind[i]!)) / model.massKg + (i === 2 ? model.gravityMps2 : 0)) as SensorVector
        velocityMps = velocityMps.map((n, i) => n + accelerationMps2[i]! * dtS) as SensorVector
        positionM = positionM.map((n, i) => n + velocityMps[i]! * dtS) as SensorVector
      }
      const contactDownM = groundDownM + groundGradient[0]! * positionM[0] + groundGradient[1]! * positionM[1]
      groundContact = positionM[2] >= contactDownM
      if (groundContact) { positionM[2] = contactDownM; if (velocityMps[2] > 0) velocityMps[2] = 0; accelerationMps2[2] = 0 }
      if (configured && groundContact) {
        const c = properties().cgBodyM, positionLever = rotateBodyToNed(quaternionWxyz, c), velocityLever = rotateBodyToNed(quaternionWxyz, cargoCross(angularRateRadS, c))
        centerPositionM = positionM.map((n, i) => n + positionLever[i]!) as SensorVector
        centerVelocityMps = velocityMps.map((n, i) => n + velocityLever[i]!) as SensorVector
      }
      if (![...positionM, ...velocityMps, ...angularRateRadS].every(Number.isFinite)) throw new RangeError('Physics model diverged')
      return snapshot()
    },
  }
  if (!configured) return body
  function loadSnapshot(): LoadSnapshot { return { properties: properties(), centerPositionM: [...centerPositionM!], centerVelocityMps: [...centerVelocityMps!] } }
  function side(): SeparationSide {
    return { properties: properties(), bodyPositionM: [...positionM], bodyVelocityMps: [...velocityMps], quaternionWxyz: [...quaternionWxyz], angularRateRadS: [...angularRateRadS], actualMotorsN: [...motorsN], centerPositionM: [...centerPositionM!], centerVelocityMps: [...centerVelocityMps!] }
  }
  function separateCarriedLoad(...args: unknown[]): LoadSeparation {
    if (args.length !== 0) throw new TypeError('cargo-load-separation-arguments')
    if (!attached) return Object.freeze({ outcome: 'refused', reason: 'already-separated' })
    const before = side(), r: SensorVector = [configured!.load.forwardM, 0, 0]
    const positionLever = rotateBodyToNed(quaternionWxyz, r), velocityLever = rotateBodyToNed(quaternionWxyz, cargoCross(angularRateRadS, r))
    const parcel = { massKg: configured!.load.massKg, positionM: positionM.map((n, i) => n + positionLever[i]!) as SensorVector, velocityMps: velocityMps.map((n, i) => n + velocityLever[i]!) as SensorVector }
    attached = false; centerPositionM = [...positionM]; centerVelocityMps = [...velocityMps]
    return { outcome: 'separated', reason: 'prescribed-zero-ejection', before, after: side(), parcel }
  }
  return { ...body, loadSnapshot, separateCarriedLoad }
}
export type RigidBodyState = ReturnType<ReturnType<typeof createRigidBody>['snapshot']>
