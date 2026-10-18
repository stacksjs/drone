import type { SensorVector } from '../sensors/types'
import type { ImuMeasurement } from '../sensors/types'
import type { AuthorityScenario } from '../authority/harness'
import { createAuthorityHarness } from '../authority/harness'
import type { Motors } from './model'
import { createEstimator } from '../estimation/estimator'
import { quaternionEuler } from '../estimation/frames'
import { createRigidBody } from './physics'
import { createPhysicsSensorFeed } from './sensors'
import { createSimulatedMultirotorController } from './controller'
import { multirotorModel } from './model'
export const controlScenarios = ['hover', 'step', 'wind', 'delay', 'imu-loss'] as const
export type ControlScenario = typeof controlScenarios[number]
export function simulateMultirotor(options: { scenario?: ControlScenario, seconds?: number, sensorDelayMs?: number, physicsStepMs?: 2 | 4, authorityScenario?: AuthorityScenario } = {}) {
  const scenario = options.scenario ?? 'step', seconds = options.seconds ?? 20, delay = options.sensorDelayMs ?? (scenario === 'delay' ? 20 : 0), stepMs = options.physicsStepMs ?? 4
  if (!controlScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 2 || seconds > 60 || ![2, 4].includes(stepMs)) throw new RangeError('Invalid control scenario, duration (2..60 s) or physics step')
  const authority = options.authorityScenario === undefined ? null : createAuthorityHarness(options.authorityScenario)
  const body = createRigidBody(), feed = createPhysicsSensorFeed(delay)
  // Initial world yaw is exactly zero by construction. Only stationary startup uses gravity correction.
  const estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only' })
  const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
  let command: Motors = [0, 0, 0, 0], priorCommand: Motors = [0, 0, 0, 0], output: ReturnType<typeof controller.step> | null = null
  let sensors = feed.advanceTo(0)
  let estimate = estimator.snapshot(0), state = body.snapshot(), firstInhibitMs: number | null = null, active = false
  let limitedTicks = 0, maxTiltRad = 0, maxCommandSlewNPerS = 0, maxRateRadS = 0, tailError2 = 0, tailCount = 0, groundContacts = 0, maxControlImuAgeMs = 0
  const trace: { atMs: number, positionM: SensorVector, estimatedPositionM: number[] | null, targetM: SensorVector, eulerRad: SensorVector, inhibited: boolean, motorsN: Motors }[] = []
  const targetAt = (at: number): SensorVector => scenario !== 'hover' && at >= 2000 ? [2, 1, -1.5] : [0, 0, -1]
  for (let tick = 0; tick <= Math.floor(seconds * 1000 / stepMs); tick++) {
    const nowMs = tick * stepMs
    if (authority) command = authority.boardTick(nowMs)
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
      output = controller.step({ kind: 'simulation', enabled: !authority || decision?.state === 'autonomous', nowMs, estimate, angularRateRadS: imu?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: observation?.estimatedCaptureMs ?? -Infinity, target: { ...(decision?.target ?? { positionM: targetAt(nowMs), yawRad: 0 }), issuedAtMs: nowMs } })
      command = authority ? authority.apply(output, nowMs) : output.motorsN
      if (!output.inhibited) active = true
      if (active && output.inhibited && firstInhibitMs === null) firstInhibitMs = nowMs
      if (!output.inhibited) maxControlImuAgeMs = Math.max(maxControlImuAgeMs, nowMs - (observation?.estimatedCaptureMs ?? nowMs))
      if (output.limited) limitedTicks++
      if (!output.inhibited) maxCommandSlewNPerS = Math.max(maxCommandSlewNPerS, ...command.map((n, i) => Math.abs(n - priorCommand[i]!) / 0.02))
      priorCommand = [...command]
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
  return {
    evidence: 'owned-rigid-body-simulation' as const, scenario, seconds, physicsStepMs: stepMs, additionalSensorDelayMs: delay,
    physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, headingAlignment: 'declared-initial-simulation-north', gravityCorrection: 'initialization-only', supportWarmupMs: 600,
    model: multirotorModel, response: {
      targetStepAtMs: scenario === 'hover' ? null : 2000,
      positionSettledAtMs: trace.find((row, index) => row.atMs >= (scenario === 'wind' ? 8000 : 2000) && trace.slice(index).length >= 6 && trace.slice(index).every(next => Math.hypot(...next.positionM.map((n, i) => n - next.targetM[i]!)) < 0.2))?.atMs ?? null,
      peakPositionErrorAfterStepM: Math.max(...trace.filter(row => row.atMs >= 2000).map(row => Math.hypot(...row.positionM.map((n, i) => n - row.targetM[i]!)))),
    }, metrics: { active, firstInhibitMs, finalPositionErrorM: Math.hypot(...state.positionM.map((n, i) => n - finalTarget[i]!)), tailPositionRmsM: Math.sqrt(tailError2 / Math.max(1, tailCount)), maxTiltRad, maxRateRadS, maxCommandSlewNPerS, limitedTicks, groundContacts, maxControlImuAgeMs },
    state, estimate, control: output, trace, authority: authority?.snapshot(seconds * 1000) ?? null,
  }
}
