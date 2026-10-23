import type { EstimatorSnapshot } from '../estimation/estimator'
import type { ImuMeasurement, SensorVector } from '../sensors/types'
import type { VehicleBatteryObservation, VehicleControlOutput, VehicleControllerContext, VehicleMeasurement, VehicleMeasurementPose, VehicleMissionAction, VehicleProfile, VehicleVtolTransitionObservation } from './types'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createEstimator } from '../estimation/estimator'
import { observeMission } from '../missions/engine'
import { createVehicleMissionEngine, validateVehicleMission } from '../missions/vehicle'
import { createVehicleAuthoritySupervisor, createVehicleOutputWatchdog } from '../authority/vehicle'
import { captureVehicleBatteryModel, createVehicleMeasurementQualifier, observeVehicleBattery, predictVehicleMeasurementPose, vehicleReference } from './measurements'
type ScheduledMissionAction = { atMs: number, action: Exclude<VehicleMissionAction, 'start'> }
function captureMissionActions(input: unknown, maximumMs: number): ScheduledMissionAction[] {
  function invalid(): never { throw new TypeError('Invalid vehicle mission action schedule') }
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 32 || Reflect.ownKeys(input).length !== input.length + 1) invalid()
  const result: ScheduledMissionAction[] = []
  let previousMs = 600
  for (let i = 0; i < input.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(i))
    if (!slot || !('value' in slot) || !slot.value || typeof slot.value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(slot.value)) || Reflect.ownKeys(slot.value).length !== 2) invalid()
    const time = Object.getOwnPropertyDescriptor(slot.value, 'atMs'), action = Object.getOwnPropertyDescriptor(slot.value, 'action')
    if (!time || !('value' in time) || !Number.isSafeInteger(time.value) || time.value <= previousMs || time.value > maximumMs || time.value % 20 !== 0 || !action || !('value' in action) || !['pause', 'resume', 'recover', 'abort'].includes(action.value)) invalid()
    result.push({ atMs: time.value, action: action.value })
    previousMs = time.value
  }
  return result
}
/** Owned raw sensor -> estimator -> mission -> vehicle policy -> authority -> independent board loop. */
export function runVehicleSimulation(profileInput: VehicleProfile, options: { scenario?: string, seconds?: number, neutralTailMs?: number, missionActions?: readonly ScheduledMissionAction[] } = {}) {
  const scenario = options.scenario ?? profileInput.scenario, seconds = options.seconds ?? 120
  const neutralTailMs = options.neutralTailMs ?? 0
  let missionActionIndex = 0
  if (!Number.isSafeInteger(neutralTailMs) || neutralTailMs < 0 || neutralTailMs > 15000 || neutralTailMs % 4 !== 0) throw new RangeError('Invalid independent vehicle neutral tail')
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 180 || scenario !== profileInput.scenario || !profileInput.scenarios.includes(scenario) || profileInput.evidence !== 'modeled-vehicle-profile' || profileInput.physicalFlightEnabled !== false) throw new RangeError('Invalid vehicle simulation profile, scenario or duration')
  const missionActions = captureMissionActions(options.missionActions, seconds * 1000)
  const { plan, worstCaseMs, requiredWh } = validateVehicleMission(profileInput.mission)
  const batteryModel = captureVehicleBatteryModel(profileInput.batteryModel, plan.power)
  if (profileInput.vehicle !== plan.vehicle || plan.origin.latitudeDeg !== 0 || plan.origin.longitudeDeg !== 0 || plan.origin.ellipsoidHeightM !== 100) throw new TypeError('Vehicle fixture requires its declared 0,0,100 WGS84 origin')
  const hasTransitions = plan.tasks.some(task => task.kind === 'vtol-mode')
  let transitionObservation: VehicleVtolTransitionObservation | null = null
  const actuators = structuredClone(profileInput.actuators), fence = structuredClone(profileInput.authorityFence)
  const session = profileInput.createSession(), navigation = session.createNavigation?.()
  if (profileInput.vehicle === 'subsea' && !navigation) throw new TypeError('Subsea profile requires owned pressure/DVL navigation')
  const engine = createVehicleMissionEngine(plan), plant = session.createPlant(), controller = session.createController()
  const supervisor = createVehicleAuthoritySupervisor({ bootId: 55n, sessionId: 123n, vehicle: profileInput.vehicle, actuators, fence })
  const board = createVehicleOutputWatchdog({ bootId: 55n, sessionId: 123n, vehicle: profileInput.vehicle, actuators })
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ origin: plan.origin, gravityCorrection: 'initialization-only' })
  const qualifier = createVehicleMeasurementQualifier(profileInput.vehicle, batteryModel ?? undefined)
  const observedSensors = { imu: 0, gnss: 0 }, sensorSequences = { imu: 0, gnss: 0 }
  let truth = plant.snapshot(), mission = engine.snapshot()
  let estimate: EstimatorSnapshot = estimator.snapshot(0)
  let measurement: VehicleMeasurement | null = null, measurementPose: VehicleMeasurementPose | null = null
  let batteryObservation: VehicleBatteryObservation | null = null
  const queue: { measurement: VehicleMeasurement, pose: VehicleMeasurementPose | null }[] = []
  const requested = new Set<string>()
  let status: 'completed' | 'blocked' | 'host-lost' | 'duration-exhausted' = 'duration-exhausted', fault: string | null = null, hostLostAt: number | null = null
  const path: { atMs: number, positionM: SensorVector | null, truthPositionM: SensorVector, mission: typeof mission, measurement: VehicleMeasurement | null, measurementPose: VehicleMeasurementPose | null, actuators: number[], transitionObservation?: VehicleVtolTransitionObservation | null }[] = []
  const transitions: { atMs: number, state: string, taskId: string, reason: string }[] = []
  let previousState = '', previousTask = ''
  const payload = session.createPayload?.()
  let finalAtMs = 0
  try {
    for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
      finalAtMs = nowMs
      const faults = profileInput.faults(scenario, nowMs, 'host'), boardState = board.tick(nowMs)
      if (nowMs > 600) truth = plant.step(boardState.actuators, 0.004, { windMps: faults.windMps ?? [0, 0, 0], currentMps: faults.currentMps ?? [0, 0, 0] })
      if (faults.hostLost) hostLostAt ??= nowMs
      if (nowMs >= 600) session.observeIndependent?.(structuredClone(truth), nowMs, [...boardState.actuators], hostLostAt === null)
      if (hostLostAt !== null) {
        if (nowMs - hostLostAt >= 100) { status = 'host-lost'; fault = board.snapshot().fault ?? 'host-lost'; break }
        continue
      }
      feed.capture(truth, nowMs, faults.dropImu, profileInput.vehicle === 'subsea' || faults.dropPosition)
      const sensors = feed.advanceTo(nowMs)
      for (const kind of ['imu', 'gnss'] as const) {
        const sequence = sensors.sensors.find(sensor => sensor.kind === kind)?.observation?.sequence ?? 0
        if (sequence > sensorSequences[kind]) { observedSensors[kind]++; sensorSequences[kind] = sequence }
      }
      const baseEstimate = estimator.update(sensors)
      estimate = navigation ? navigation.update(baseEstimate, measurement, nowMs) : baseEstimate
      if (nowMs % 20 !== 0) continue
      const reference = vehicleReference(estimate)
      const imuObservation = sensors.sensors.find(s => s.kind === 'imu')?.observation
      const capturePose = predictVehicleMeasurementPose(estimate, imuObservation, nowMs)
      if ((capturePose || profileInput.vehicle === 'subsea') && !faults.dropVehicleSensor) {
        if (queue.length >= 8) throw new RangeError('Vehicle sensor queue exhausted')
        const packet = structuredClone(session.renderMeasurement(truth, nowMs, reference))
        if (packet.capturedAtMs !== nowMs || !Number.isSafeInteger(packet.receivedAtMs) || packet.receivedAtMs < nowMs + 20 || packet.receivedAtMs > nowMs + 100) throw new TypeError('Vehicle renderer must declare capture and bounded receipt epochs')
        queue.push({ measurement: packet, pose: capturePose })
        queue.sort((a, b) => a.measurement.receivedAtMs - b.measurement.receivedAtMs || a.measurement.sequence - b.measurement.sequence)
      }
      while (queue[0] && queue[0].measurement.receivedAtMs <= nowMs) { const entry = queue.shift()!; measurement = entry.measurement; measurementPose = entry.pose }
      let qualified: VehicleMeasurement | null = null
      try { qualified = qualifier.qualify(measurement, nowMs, reference) }
      catch (error) { fault ??= error instanceof Error ? error.message : 'vehicle-sensor-envelope'; measurementPose = null }
      measurement = qualified
      if (batteryModel && qualified) {
        batteryObservation = observeVehicleBattery(qualified, batteryModel, nowMs)
        if (batteryObservation.cutoff) fault ??= 'modeled-battery-supply-cutoff'
      }
      if (navigation) estimate = navigation.update(baseEstimate, qualified, nowMs)
      if (nowMs < 600) continue
      const b = board.snapshot()
      const batteryPercent = batteryModel ? qualified && batteryObservation && !batteryObservation.cutoff ? batteryObservation.remainingPercentLowerBound : 0 : 100 - plan.power.maxW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
      const observation = { kind: 'simulation' as const, nowMs, estimate,
        runtime: { bootId: b.bootId, capturedAtMs: nowMs, watchdogHealthy: b.fault === null },
        rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: faults.rcOverride ?? false },
        interlocks: { capturedAtMs: qualified?.capturedAtMs ?? nowMs - 1000, killActive: faults.kill ?? false, onGround: qualified?.values.onSurface === true, motorsStopped: qualified?.values.stopped === true },
        battery: { capturedAtMs: batteryModel ? qualified?.capturedAtMs ?? nowMs - 1000 : nowMs, remainingPercent: batteryPercent }, link: { capturedAtMs: nowMs, connected: !faults.linkLost } }
      const send = (action: 'arm' | 'engage' | 'renew' | 'disarm', targetM = mission.targetM) => {
        const s = supervisor.snapshot()
        return supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: targetM ?? [0, 0, 0], yawRad: 0 } })
      }
      supervisor.update(observation)
      if (nowMs === 600) { send('arm'); send('engage', [0, 0, 0]) }
      const context: VehicleControllerContext = { nowMs, enabled: supervisor.snapshot().state === 'autonomous', estimate, measurement, measurementPose, mission,
        ...(profileInput.vehicle === 'vtol' ? { controlRate: capturePose ? { evidence: 'modeled-qualified-imu' as const, reference: capturePose.reference, capturedAtMs: capturePose.gyroCapturedAtMs, angularRateRadS: [...(imuObservation!.value as ImuMeasurement).angularRateRadS] as SensorVector } : null } : {}),
      }
      payload?.observe?.(structuredClone(context))
      const ack = payload?.poll(nowMs) ?? null
      const missionObservation = { ...observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent, onGround: qualified?.values.onSurface === true }, profileInput.vehicle === 'subsea' ? 'LOCAL_WATER_SURFACE' : 'WGS84_ELLIPSOID'), payloadAck: ack, ...(hasTransitions ? { transition: transitionObservation } : {}) }
      transitionObservation = null
      let action: VehicleMissionAction | undefined = nowMs === 600 ? 'start' : undefined
      const scheduled = missionActions[missionActionIndex]
      if (scheduled?.atMs === nowMs) { action = scheduled.action; missionActionIndex++ }
      mission = engine.step(missionObservation, action)
      if (mission.payload && !requested.has(mission.payload.eventId)) {
        if (!payload) { fault ??= 'missing-vehicle-payload-port'; send('disarm') }
        else { payload.observe?.(structuredClone({ ...context, mission })); payload.request(structuredClone(mission.payload)); requested.add(mission.payload.eventId) }
      }
      const active = mission.state === 'running' || mission.state === 'paused'
      if (active && mission.targetM && !fault) send('renew')
      else { send('disarm'); board.revoke() }
      const output: VehicleControlOutput = controller.step({ ...context, enabled: supervisor.snapshot().state === 'autonomous', mission })
      if (hasTransitions && active && !output.inhibited && supervisor.snapshot().state === 'autonomous') transitionObservation = output.transition ? structuredClone(output.transition) : null
      if (active && output.inhibited && supervisor.snapshot().state === 'autonomous') { fault ??= output.reason; send('disarm'); board.revoke() }
      const frame = supervisor.gate(output, nowMs)
      if (frame) board.accept(frame, nowMs)
      else board.revoke()
      path.push({ atMs: nowMs, positionM: estimate.localPosition ? [...estimate.localPosition.positionM] as SensorVector : null, truthPositionM: [...truth.positionM], mission: structuredClone(mission), measurement: measurement ? structuredClone(measurement) : null, measurementPose: measurementPose ? structuredClone(measurementPose) : null, actuators: [...board.snapshot().actuators], ...(hasTransitions ? { transitionObservation: transitionObservation ? structuredClone(transitionObservation) : null } : {}) })
      if (mission.state !== previousState || mission.taskId !== previousTask) { transitions.push({ atMs: nowMs, state: mission.state, taskId: mission.taskId, reason: mission.reason }); previousState = mission.state; previousTask = mission.taskId }
      if (!['ready', 'running', 'paused'].includes(mission.state)) { status = mission.state === 'completed' ? 'completed' : 'blocked'; fault ??= mission.state === 'completed' ? null : mission.reason; break }
    }
  }
  finally { payload?.close(); if (status !== 'host-lost') board.revoke() }
  // Opt-in material/actuator settling has no host sensor, estimation, mission or control work.
  const hostEndAtMs = finalAtMs
  for (let elapsed = 4; elapsed <= neutralTailMs; elapsed += 4) {
    const nowMs = hostEndAtMs + elapsed, faults = profileInput.faults(scenario, nowMs, 'independent-tail'), boardState = board.tick(nowMs)
    truth = plant.step(boardState.actuators, .004, { windMps: faults.windMps ?? [0, 0, 0], currentMps: faults.currentMps ?? [0, 0, 0] })
    session.observeIndependent?.(structuredClone(truth), nowMs, [...boardState.actuators], false)
    finalAtMs = nowMs
  }
  return { version: 1, evidence: 'owned-vehicle-physics-simulation' as const, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, vehicle: profileInput.vehicle, scenario, status, fault, navigationEvidence: { observedSensors, datum: estimate.localPosition?.altitudeDatum ?? null, quality: [...estimate.quality], localPositionHealthy: estimate.health.localPosition }, mission, trace: engine.trace(), path, transitions, budget: { worstCaseMs, requiredWh }, authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: [...truth.positionM] as SensorVector, ...(batteryModel ? { energy: { evidence: 'modeled-vehicle-battery-v1' as const, model: batteryModel, lastObservation: batteryObservation } } : {}) }
}
