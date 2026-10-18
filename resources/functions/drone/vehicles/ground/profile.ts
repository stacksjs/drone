import type { VehicleControllerContext, VehicleControlOutput, VehicleMissionPlan, VehiclePayloadAck, VehiclePayloadPort, VehicleProfile } from '../types'
import { createGroundPlant, groundModel } from './plant'
import { createGroundOdometry, groundStoppingEnvelope } from './odometry'
import { planGroundCoverage } from './coverage'

export const groundScenarios = ['nominal', 'logistics', 'low-traction', 'obstacle', 'people', 'manual', 'localization-loss', 'emergency', 'implement-open', 'sensor-loss', 'host-loss'] as const
export type GroundScenario = typeof groundScenarios[number]
const clip = (n: number, max: number) => Math.max(-max, Math.min(max, n))
const angle = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))

export function groundMission(mode: 'mowing' | 'logistics' = 'mowing'): VehicleMissionPlan {
  const move = (id: string, positionM: [number, number, number], next: string) => ({ id, kind: 'waypoint' as const, positionM, acceptanceM: 0.22, maxArrivalSpeedMps: 0.08, settleMs: 300, timeoutMs: 22000, next })
  const coverage = planGroundCoverage({ lengthM: 3, lanes: 2, swathM: 0.8 })
  const coverageTasks = coverage.pointsM.map((point, i) => move(`coverage-${i}`, point, i === coverage.pointsM.length - 1 ? 'disable' : `coverage-${i + 1}`))
  return { version: 2, vehicle: 'ground', id: mode === 'mowing' ? 'ground-mowing-coverage' : 'ground-materials-logistics', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -0.3, maxDownM: 0.3 }, rallyM: [0, 0, 0], power: { availableWh: 100, maxW: 250, reservePercent: 30 }, start: 'start', tasks: mode === 'mowing' ? [
    { id: 'start', kind: 'start', next: 'enable' },
    { id: 'enable', kind: 'payload', operation: 'mower-enable', containerId: null, timeoutMs: 1000, next: 'coverage-0' },
    ...coverageTasks,
    { id: 'disable', kind: 'payload', operation: 'mower-disable', containerId: null, timeoutMs: 1000, next: 'home' },
    { id: 'home', kind: 'return', acceptanceM: 0.22, maxArrivalSpeedMps: 0.08, settleMs: 300, timeoutMs: 22000, next: 'stop' },
    { id: 'stop', kind: 'stop', positionM: [0, 0, 0], acceptanceM: 0.25, maxArrivalSpeedMps: 0.1, settleMs: 300, timeoutMs: 3000 },
  ] : [
    { id: 'start', kind: 'start', next: 'depot' }, move('depot', [3, 1, 0], 'drop'),
    { id: 'drop', kind: 'payload', operation: 'material-drop', containerId: 'tray-1', timeoutMs: 1000, next: 'home' },
    { id: 'home', kind: 'return', acceptanceM: 0.22, maxArrivalSpeedMps: 0.08, settleMs: 300, timeoutMs: 22000, next: 'stop' },
    { id: 'stop', kind: 'stop', positionM: [0, 0, 0], acceptanceM: 0.25, maxArrivalSpeedMps: 0.1, settleMs: 300, timeoutMs: 3000 },
  ] }
}

export function createGroundProfile(scenario: string = 'nominal'): VehicleProfile {
  if (!groundScenarios.includes(scenario as GroundScenario)) throw new RangeError('Unknown ground scenario')
  let sequence = 0, mowerEnabled = false, context: VehicleControllerContext | null = null, closed = false, lastPoll = -Infinity
  const queue: VehiclePayloadAck[] = [], seen = new Set<string>(), consumedContainers = new Set<string>(), payloadOdometry = createGroundOdometry()
  function payloadPort(): VehiclePayloadPort {
    return {
      observe(next) { context = structuredClone(next) },
      request(command) {
        if (closed || seen.has(command.eventId) || seen.size >= 32 || queue.length > 0) throw new Error('Ground payload event already consumed or closed')
        if (!/^[A-Za-z0-9:,_-]{1,200}$/.test(command.eventId) || !/^[A-Za-z0-9:_-]{1,120}$/.test(command.taskId) || !Number.isSafeInteger(command.issuedAtMs) || command.issuedAtMs < 0 || !Number.isSafeInteger(command.expiresAtMs) || command.expiresAtMs <= command.issuedAtMs || command.expiresAtMs - command.issuedAtMs > 5000 || !Array.isArray(command.positionM) || command.positionM.length !== 3 || !command.positionM.every(Number.isFinite)) throw new TypeError('Invalid ground payload command')
        seen.add(command.eventId)
        const c = context, v = c?.measurement?.values
        const qualified = c ? payloadOdometry.step(c.measurement, c.estimate, c.nowMs).healthy : false
        const fresh = !!c && !!c.measurement && c.enabled && c.nowMs >= command.issuedAtMs && c.nowMs <= command.expiresAtMs && c.measurement.reference === command.reference && c.nowMs - c.measurement.capturedAtMs <= 140 && c.measurement.receivedAtMs <= c.nowMs
        const stationary = !!c?.estimate.localPosition && Math.hypot(...c.estimate.localPosition.velocityMps) <= 0.16 && v?.stopped === true
        const located = !!c?.estimate.localPosition && Math.hypot(...command.positionM.map((n, i) => n - c.estimate.localPosition!.positionM[i]!)) <= 0.25
        const safe = located && qualified && fresh && stationary && v?.onSurface === true && v?.guardClosed === true && v?.emergency === false && v?.bumper === false && Number(v?.personMm) > 2000 && Number(v?.obstacleMm) > 1000
        const supported = (command.operation === 'mower-enable' || command.operation === 'mower-disable') ? command.containerId === null : command.operation === 'material-drop' && command.containerId === 'tray-1' && !consumedContainers.has(command.containerId) && !mowerEnabled
        const confirmed = safe && supported
        if (confirmed && command.operation === 'material-drop') consumedContainers.add(command.containerId!)
        if (confirmed && command.operation === 'mower-enable') mowerEnabled = true
        if (command.operation === 'mower-disable') mowerEnabled = false
        queue.push({ eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, reference: command.reference, capturedAtMs: command.issuedAtMs + 60, positionM: c?.estimate.localPosition ? [...c.estimate.localPosition.positionM] as [number, number, number] : [...command.positionM], outcome: confirmed ? 'confirmed' : 'rejected', metadata: { modeledOnly: true, implement: command.operation, container: command.containerId ?? 'none' } })
      },
      poll(nowMs) {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < lastPoll) throw new RangeError('Ground payload clock must be monotonic')
        lastPoll = nowMs
        return queue[0] && queue[0].capturedAtMs <= nowMs ? structuredClone(queue.shift()!) : null },
      close() { closed = true; mowerEnabled = false; queue.length = 0; context = null },
    }
  }
  return {
    vehicle: 'ground', name: 'Owned differential ground vehicle', evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false,
    actuators: [{ name: 'left-wheel-torque', unit: 'normalized', min: -1, max: 1, neutral: 0 }, { name: 'right-wheel-torque', unit: 'normalized', min: -1, max: 1, neutral: 0 }, { name: 'mower-enable', unit: 'normalized', min: 0, max: 1, neutral: 0 }, { name: 'spring-brake', unit: 'normalized', min: 0, max: 1, neutral: 1 }],
    authorityFence: { radiusM: 12, minDownM: -0.3, maxDownM: 0.3 }, mission: groundMission(scenario === 'logistics' ? 'logistics' : 'mowing'), scenarios: groundScenarios,
    createPlant: () => createGroundPlant({ friction: scenario === 'low-traction' ? 0.015 : groundModel.grip }),
    createPayload: payloadPort,
    createController() {
      const odometry = createGroundOdometry()
      let latch: string | null = null, previousNow: number | null = null
      function output(c: VehicleControllerContext, actuators: number[], inhibited: boolean, reason: string): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'ground', atMs: c.nowMs, actuators, inhibited, reason, physicalFlightEnabled: false, boardOutputsInhibited: true } }
      return { step(c) {
        const o = odometry.step(c.measurement, c.estimate, c.nowMs)
        const gap = previousNow !== null && c.nowMs - previousNow > 40
        previousNow = c.nowMs
        if (!c.enabled) { mowerEnabled = false; return output(c, [0, 0, 0, 1], false, 'ground-authority-inhibited') }
        if (!o.healthy) latch ??= o.reason
        else if (gap) latch ??= 'ground-controller-gap'
        else if (o.emergency) latch ??= 'ground-emergency-stop'
        else if (!o.onSurface || !o.guardClosed) latch ??= 'ground-implement-interlock'
        else if (o.personM <= Math.max(2, groundStoppingEnvelope(o.speedMps, c.nowMs - c.measurement!.capturedAtMs + 1, o.uncertaintyM))) latch ??= 'ground-person-proximity'
        else if (o.obstacleM <= groundStoppingEnvelope(o.speedMps, c.nowMs - c.measurement!.capturedAtMs + 1, o.uncertaintyM)) latch ??= 'ground-obstacle-stopping-envelope'
        if (latch) { mowerEnabled = false; return output(c, [0, 0, 0, 1], true, latch) }
        const goal = c.mission.targetM
        if (!goal || !['running', 'paused'].includes(c.mission.state)) { mowerEnabled = false; return output(c, [0, 0, 0, 1], false, 'ground-no-task') }
        const dn = goal[0] - o.positionM[0], de = goal[1] - o.positionM[1], distance = Math.hypot(dn, de)
        const error = distance > 0.1 ? angle(Math.atan2(de, dn) - o.yawRad) : 0
        const targetSpeed = distance < 0.12 ? 0 : Math.min(0.65, distance * 0.7) * Math.max(0, Math.cos(error)) * (Math.abs(error) > 0.7 ? 0 : 1)
        const desiredYawRate = distance < 0.12 ? 0 : clip(error * 1.5, 0.8)
        const drive = clip(1.3 * (targetSpeed - o.speedMps) + 0.12 * targetSpeed, 0.65)
        const turn = clip(0.7 * (desiredYawRate - o.yawRateRadS), 0.5)
        return output(c, [clip(drive - turn, 1), clip(drive + turn, 1), mowerEnabled ? 1 : 0, distance < 0.12 ? 1 : 0], false, 'ground-estimator-wheel-control')
      } }
    },
    renderMeasurement(state, atMs, reference) {
      const active = atMs >= 4000
      return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'ground', sequence: ++sequence, reference, capturedAtMs: atMs, receivedAtMs: atMs + 40, values: {
        calibration: 'ground-4096-015-060-v1', clockUncertaintyMs: 1,
        encoderCounts: [Number(state.details.leftAngleRad), Number(state.details.rightAngleRad)].map(v => Math.round(v * groundModel.encoderCountsPerRev / (2 * Math.PI))),
        onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) < 0.12,
        obstacleMm: scenario === 'obstacle' && active ? 700 : 20000,
        personMm: scenario === 'people' && active ? 1500 : 20000,
        guardClosed: !(scenario === 'implement-open' && active), emergency: scenario === 'emergency' && active, bumper: false,
      } }
    },
    faults(name, atMs) { return atMs < 4000 ? {} : { dropPosition: name === 'localization-loss', dropVehicleSensor: name === 'sensor-loss', hostLost: name === 'host-loss', rcOverride: name === 'manual' } },
  }
}
