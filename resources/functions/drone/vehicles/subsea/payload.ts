import type { VehicleControllerContext, VehiclePayloadAck, VehiclePayloadCommand, VehiclePayloadPort } from '../types'
import { qualifySubseaMeasurement } from './sensors'

function sameScope(context: VehicleControllerContext | null, command: VehiclePayloadCommand): boolean {
  const active = context?.mission.payload
  return !!context && context.enabled && context.mission.vehicle === 'subsea' && context.mission.state === 'running'
    && context.mission.taskKind === 'payload' && context.mission.taskId === command.taskId && context.nowMs >= command.issuedAtMs && context.nowMs < command.expiresAtMs
    && !!active && active.eventId === command.eventId && active.taskId === command.taskId && active.operation === command.operation && active.containerId === null
    && active.issuedAtMs === command.issuedAtMs && active.expiresAtMs === command.expiresAtMs && active.reference === command.reference
    && active.positionM.length === 3 && active.positionM.every((value, index) => value === command.positionM[index])
}
/** Modeled evidence acquisition only. A command never authorizes physical camera or sonar hardware. */
export function createSubseaCapture(): VehiclePayloadPort {
  let pending: VehiclePayloadCommand | null = null, observed: VehicleControllerContext | null = null, closed = false, uncertain = false, lastPollMs = -Infinity
  const events = new Set<string>(), frames = new Set<string>()
  return {
    observe(context) {
      if (closed) return
      observed = structuredClone(context)
      if (pending && !sameScope(observed, pending)) uncertain = true
    },
    request(command) {
      if (closed || pending || events.size >= 32 || command.operation !== 'inspection-capture' || command.containerId !== null || !command.eventId || command.eventId.length > 200 || !/^[a-z][a-z0-9-]{0,39}$/.test(command.taskId) || !command.reference || command.reference.length > 120 || !Array.isArray(command.positionM) || command.positionM.length !== 3 || !command.positionM.every(Number.isFinite) || !Number.isSafeInteger(command.issuedAtMs) || command.issuedAtMs < 0 || !Number.isSafeInteger(command.expiresAtMs) || command.expiresAtMs - command.issuedAtMs < 100 || command.expiresAtMs - command.issuedAtMs > 10000 || events.has(command.eventId)) throw new RangeError('Inspection command rejected: invalid or previously used event scope')
      pending = structuredClone(command); events.add(command.eventId); uncertain = !sameScope(observed, pending)
    },
    poll(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < lastPollMs) throw new RangeError('Inspection clock must be monotonic')
      lastPollMs = nowMs
      if (closed || !pending) return null
      const command = pending
      let capturedAtMs = nowMs, positionM = [...command.positionM] as [number, number, number]
      let metadata: NonNullable<VehiclePayloadAck['metadata']> = { evidence: 'modeled-subsea-capture', physicalImageVerified: false, physicalSonarVerified: false }
      try {
        if (uncertain || !observed || observed.nowMs !== nowMs || !sameScope(observed, command)) throw new Error('Inspection scope or authority lost')
        const m = qualifySubseaMeasurement(observed.measurement, nowMs, command.reference), pose = observed.measurementPose
        if (!m) throw new Error('Inspection sensor data unqualified')
        if (m.capturedAtMs < command.issuedAtMs) return null
        const p = observed.estimate.localPosition
        if (!pose || !Array.isArray(pose.positionM) || pose.positionM.length !== 3 || !pose.positionM.every(Number.isFinite) || !Array.isArray(pose.quaternionWxyz) || pose.quaternionWxyz.length !== 4 || !pose.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 0.001 || pose.capturedAtMs !== m.capturedAtMs || pose.reference !== command.reference || pose.positionPredictedToMs !== m.capturedAtMs || pose.attitudePredictedToMs !== m.capturedAtMs || pose.attitudePrediction !== 'qualified-gyro-hold' || pose.gyroCapturedAtMs !== pose.attitudeCapturedAtMs || ![pose.positionCapturedAtMs, pose.attitudeCapturedAtMs].every(at => Number.isSafeInteger(at) && at >= 0 && at <= m.capturedAtMs) || m.capturedAtMs - pose.positionCapturedAtMs > 200 || m.capturedAtMs - pose.attitudeCapturedAtMs > 60) throw new Error('Inspection capture pose unqualified')
        if (!p || !observed.estimate.health.localPosition || observed.estimate.nowMs !== nowMs || p.altitudeDatum !== 'LOCAL_WATER_SURFACE' || `${observed.estimate.bootId}:${Object.values(observed.estimate.resets).join(',')}` !== command.reference || p.capturedAtMs === null || nowMs - p.capturedAtMs > 200 || p.capturedAtMs > nowMs || p.predictedToMs !== nowMs || Math.hypot(...p.velocityMps) > 0.12) throw new Error('Inspection navigation unqualified')
        if (Math.hypot(...pose.positionM.map((n, i) => n - command.positionM[i]!)) > 0.25 || m.values.leak !== false || m.values.linkConnected !== true || m.values.dvlLocked !== true || m.values.emergency !== false || Number(m.values.tetherTensionN) >= 40 || frames.has(String(m.values.cameraFrameId))) throw new Error('Inspection capture envelope lost')
        capturedAtMs = m.capturedAtMs; positionM = [...pose.positionM]
        metadata = { ...metadata, cameraFrameId: String(m.values.cameraFrameId), measurementSequence: m.sequence, sonarRangeM: Number(m.values.structureRangeM), bottomRangeM: Number(m.values.bottomRangeM), clockSigmaMs: Number(m.values.clockSigmaMs), cameraLumaHex: (m.values.cameraLuma as number[]).map(n => n.toString(16).padStart(2, '0')).join(''), orientationWxyz: pose.quaternionWxyz.join(','), positionSourceAtMs: pose.positionCapturedAtMs, attitudeSourceAtMs: pose.attitudeCapturedAtMs, gyroSourceAtMs: pose.gyroCapturedAtMs }
        frames.add(String(m.values.cameraFrameId)); pending = null
        return { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: null, capturedAtMs, reference: command.reference, positionM, outcome: 'confirmed', metadata }
      }
      catch {
        pending = null; uncertain = true
        return { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: null, capturedAtMs, reference: command.reference, positionM, outcome: 'uncertain', metadata }
      }
    },
    close() { closed = true; pending = null; observed = null },
  }
}
