import type { SensorVector } from '../sensors/types'
import type { VehicleControlOutput, VehicleControllerContext, VehicleMeasurement, VehicleMeasurementPose, VehicleProfile } from './types'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createEstimator } from '../estimation/estimator'
import { observeMission } from '../missions/engine'
import { createVehicleMissionEngine, validateVehicleMission } from '../missions/vehicle'
import { createVehicleAuthoritySupervisor, createVehicleOutputWatchdog } from '../authority/vehicle'
import { createVehicleMeasurementQualifier, predictVehicleMeasurementPose, vehicleReference } from './measurements'
export { vehicleReference } from './measurements'
/** Owned raw sensor -> estimator -> mission -> vehicle policy -> authority -> independent board loop. */
export function runVehicleSimulation(profileInput: VehicleProfile, options: { scenario?: string, seconds?: number } = {}) {
  const scenario = options.scenario ?? 'nominal', seconds = options.seconds ?? 120
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 180 || !profileInput.scenarios.includes(scenario) || profileInput.evidence !== 'modeled-vehicle-profile' || profileInput.physicalFlightEnabled !== false) throw new RangeError('Invalid vehicle simulation profile, scenario or duration')
  const { plan, worstCaseMs, requiredWh } = validateVehicleMission(profileInput.mission)
  if (profileInput.vehicle !== plan.vehicle || plan.origin.latitudeDeg !== 0 || plan.origin.longitudeDeg !== 0 || plan.origin.ellipsoidHeightM !== 100) throw new TypeError('Vehicle fixture requires its declared 0,0,100 WGS84 origin')
  const actuators = structuredClone(profileInput.actuators), fence = structuredClone(profileInput.authorityFence)
  const session = profileInput.createSession()
  const engine = createVehicleMissionEngine(plan), plant = session.createPlant(), controller = session.createController()
  const supervisor = createVehicleAuthoritySupervisor({ bootId: 55n, sessionId: 123n, vehicle: profileInput.vehicle, actuators, fence })
  const board = createVehicleOutputWatchdog({ bootId: 55n, sessionId: 123n, vehicle: profileInput.vehicle, actuators })
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ origin: plan.origin, gravityCorrection: 'initialization-only' })
  const qualifier = createVehicleMeasurementQualifier(profileInput.vehicle)
  let truth = plant.snapshot(), estimate = estimator.snapshot(0), mission = engine.snapshot()
  let measurement: VehicleMeasurement | null = null, measurementPose: VehicleMeasurementPose | null = null
  const queue: { measurement: VehicleMeasurement, pose: VehicleMeasurementPose }[] = []
  const requested = new Set<string>()
  let status: 'completed' | 'blocked' | 'host-lost' | 'duration-exhausted' = 'duration-exhausted', fault: string | null = null, hostLostAt: number | null = null
  const path: { atMs: number, positionM: SensorVector | null, truthPositionM: SensorVector, mission: typeof mission, measurement: VehicleMeasurement | null, measurementPose: VehicleMeasurementPose | null, actuators: number[] }[] = []
  const transitions: { atMs: number, state: string, taskId: string, reason: string }[] = []
  let previousState = '', previousTask = ''
  const payload = session.createPayload?.()
  try {
    for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
      const faults = profileInput.faults(scenario, nowMs), boardState = board.tick(nowMs)
      if (nowMs > 600) truth = plant.step(boardState.actuators, 0.004, { windMps: faults.windMps ?? [0, 0, 0], currentMps: faults.currentMps ?? [0, 0, 0] })
      if (faults.hostLost) hostLostAt ??= nowMs
      if (hostLostAt !== null) {
        if (nowMs - hostLostAt >= 100) { status = 'host-lost'; fault = board.snapshot().fault ?? 'host-lost'; break }
        continue
      }
      feed.capture(truth, nowMs, faults.dropImu, faults.dropPosition)
      const sensors = feed.advanceTo(nowMs)
      estimate = estimator.update(sensors)
      if (nowMs % 20 !== 0) continue
      const reference = vehicleReference(estimate)
      const capturePose = predictVehicleMeasurementPose(estimate, sensors.sensors.find(s => s.kind === 'imu')?.observation, nowMs)
      if (capturePose && !faults.dropVehicleSensor) {
        if (queue.length >= 8) throw new RangeError('Vehicle sensor queue exhausted')
        const packet = structuredClone(session.renderMeasurement(truth, nowMs, reference))
        if (packet.capturedAtMs !== nowMs || !Number.isSafeInteger(packet.receivedAtMs) || packet.receivedAtMs < nowMs + 20 || packet.receivedAtMs > nowMs + 100) throw new TypeError('Vehicle renderer must declare capture and bounded receipt epochs')
        queue.push({ measurement: packet, pose: capturePose })
        queue.sort((a, b) => a.measurement.receivedAtMs - b.measurement.receivedAtMs || a.measurement.sequence - b.measurement.sequence)
      }
      while (queue[0] && queue[0].measurement.receivedAtMs <= nowMs) { const entry = queue.shift()!; measurement = entry.measurement; measurementPose = entry.pose }
      if (nowMs < 600) continue
      let qualified: VehicleMeasurement | null = null
      try { qualified = qualifier.qualify(measurement, nowMs, reference) }
      catch (error) { fault ??= error instanceof Error ? error.message : 'vehicle-sensor-envelope'; measurementPose = null }
      measurement = qualified
      const b = board.snapshot(), batteryPercent = 100 - plan.power.maxW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
      const observation = { kind: 'simulation' as const, nowMs, estimate,
        runtime: { bootId: b.bootId, capturedAtMs: nowMs, watchdogHealthy: b.fault === null },
        rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: faults.rcOverride ?? false },
        interlocks: { capturedAtMs: qualified?.capturedAtMs ?? nowMs - 1000, killActive: faults.kill ?? false, onGround: qualified?.values.onSurface === true, motorsStopped: qualified?.values.stopped === true },
        battery: { capturedAtMs: nowMs, remainingPercent: batteryPercent }, link: { capturedAtMs: nowMs, connected: true } }
      const send = (action: 'arm' | 'engage' | 'renew' | 'disarm', targetM = mission.targetM) => {
        const s = supervisor.snapshot()
        return supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: targetM ?? [0, 0, 0], yawRad: 0 } })
      }
      supervisor.update(observation)
      if (nowMs === 600) { send('arm'); send('engage', [0, 0, 0]) }
      const context: VehicleControllerContext = { nowMs, enabled: supervisor.snapshot().state === 'autonomous', estimate, measurement, measurementPose, mission }
      payload?.observe?.(structuredClone(context))
      const ack = payload?.poll(nowMs) ?? null
      const missionObservation = { ...observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent, onGround: qualified?.values.onSurface === true }), payloadAck: ack }
      mission = engine.step(missionObservation, nowMs === 600 ? 'start' : undefined)
      if (mission.payload && !requested.has(mission.payload.eventId)) {
        if (!payload) { fault ??= 'missing-vehicle-payload-port'; send('disarm') }
        else { payload.observe?.(structuredClone({ ...context, mission })); payload.request(structuredClone(mission.payload)); requested.add(mission.payload.eventId) }
      }
      const active = mission.state === 'running' || mission.state === 'paused'
      if (active && mission.targetM && !fault) send('renew')
      else { send('disarm'); board.revoke() }
      const output: VehicleControlOutput = controller.step({ ...context, enabled: supervisor.snapshot().state === 'autonomous', mission })
      if (active && output.inhibited && supervisor.snapshot().state === 'autonomous') { fault ??= output.reason; send('disarm'); board.revoke() }
      const frame = supervisor.gate(output, nowMs)
      if (frame) board.accept(frame, nowMs)
      else board.revoke()
      path.push({ atMs: nowMs, positionM: estimate.localPosition ? [...estimate.localPosition.positionM] as SensorVector : null, truthPositionM: [...truth.positionM], mission: structuredClone(mission), measurement: measurement ? structuredClone(measurement) : null, measurementPose: measurementPose ? structuredClone(measurementPose) : null, actuators: [...board.snapshot().actuators] })
      if (mission.state !== previousState || mission.taskId !== previousTask) { transitions.push({ atMs: nowMs, state: mission.state, taskId: mission.taskId, reason: mission.reason }); previousState = mission.state; previousTask = mission.taskId }
      if (!['ready', 'running', 'paused'].includes(mission.state)) { status = mission.state === 'completed' ? 'completed' : 'blocked'; fault ??= mission.state === 'completed' ? null : mission.reason; break }
    }
  }
  finally { payload?.close(); if (status !== 'host-lost') board.revoke() }
  return { version: 1, evidence: 'owned-vehicle-physics-simulation' as const, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, vehicle: profileInput.vehicle, scenario, status, fault, mission, trace: engine.trace(), path, transitions, budget: { worstCaseMs, requiredWh }, authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: [...truth.positionM] as SensorVector }
}
