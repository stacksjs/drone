import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorVector } from '../sensors/types'
import type { SimulatedControlOutput } from '../controls/controller'
import type { Motors } from '../controls/model'
import { multirotorModel } from '../controls/model'
import { createAuthorityKernel } from './core'

export const authorityVersion = 1 as const
export const authorityStates = ['disarmed', 'armed-idle', 'autonomous', 'manual', 'failsafe', 'killed'] as const
export type AuthorityState = typeof authorityStates[number]
export type AuthorityAction = 'arm' | 'engage' | 'renew' | 'disarm' | 'reset' | 'kill'
/** Missing entries are rejected. Hazards and the independent kill input take priority. */
export const authorityTransitions: Readonly<Record<AuthorityState, Readonly<Partial<Record<AuthorityAction, AuthorityState>>>>> = Object.freeze({
  'disarmed': Object.freeze({ arm: 'armed-idle', disarm: 'disarmed', kill: 'killed' }),
  'armed-idle': Object.freeze({ engage: 'autonomous', disarm: 'disarmed', kill: 'killed' }),
  'autonomous': Object.freeze({ renew: 'autonomous', disarm: 'disarmed', kill: 'killed' }),
  'manual': Object.freeze({ disarm: 'disarmed', kill: 'killed' }),
  'failsafe': Object.freeze({ reset: 'disarmed', kill: 'killed' }),
  'killed': Object.freeze({ reset: 'disarmed', kill: 'killed' }),
})
export interface PositionTarget { positionM: SensorVector, yawRad: number }
export interface AuthorityCommand {
  version: 1
  sessionId: bigint
  bootId: bigint
  epoch: number
  sequence: number
  issuedAtMs: number
  action: AuthorityAction
  mode?: 'position'
  target?: PositionTarget
  leaseMs?: number
}
export interface AuthorityObservation {
  kind: 'simulation'
  nowMs: number
  estimate: EstimatorSnapshot
  runtime: { bootId: bigint, capturedAtMs: number, watchdogHealthy: boolean }
  rc: { capturedAtMs: number, connected: boolean, armSwitch: boolean, override: boolean }
  interlocks: { capturedAtMs: number, killActive: boolean, onGround: boolean, motorsStopped: boolean }
  battery: { capturedAtMs: number, remainingPercent: number }
  link: { capturedAtMs: number, connected: boolean }
}
export interface SimulatedActuatorFrame {
  version: 1
  bootId: bigint
  sessionId: bigint
  epoch: number
  sequence: number
  issuedAtMs: number
  expiresAtMs: number
  motorsN: Motors
}
export function validMotors(motors: unknown): motors is Motors {
  return Array.isArray(motors) && motors.length === 4 && motors.every(n => Number.isFinite(n) && n >= 0 && n <= multirotorModel.maxMotorThrustN)
}
export const authorityPolicy = Object.freeze({ commandAgeMs: 100, maxLeaseMs: 100, outputLeaseMs: 60, schedulerGapMs: 40, rcAgeMs: 100, linkAgeMs: 150, batteryAgeMs: 500, runtimeAgeMs: 20, interlockAgeMs: 20, reservePercent: 25, fenceRadiusM: 20, minDownM: -10, maxDownM: 0 })
/** Strict legacy quad-X wrapper over the shared authority lifecycle. */
export function createAuthoritySupervisor(options: { sessionId: bigint, bootId: bigint }) {
  return createAuthorityKernel<SimulatedControlOutput, SimulatedActuatorFrame>({
    ...options,
    fence: { radiusM: authorityPolicy.fenceRadiusM, minDownM: authorityPolicy.minDownM, maxDownM: authorityPolicy.maxDownM },
    validateOutput: (output, nowMs) => !!output && output.atMs === nowMs && output.kind === 'simulated-control' && !output.inhibited && output.physicalFlightEnabled === false && output.boardOutputsInhibited === true && validMotors(output.motorsN),
    createFrame: (output, metadata) => ({ ...metadata, motorsN: [...output.motorsN] as Motors }),
  })
}
