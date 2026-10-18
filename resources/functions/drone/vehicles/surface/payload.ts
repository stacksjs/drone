import type { VehicleControllerContext, VehiclePayloadAck, VehiclePayloadCommand, VehiclePayloadPort } from '../types'
import { qualifySurfaceMeasurement } from './sensors'
export function createSurfaceSampler(mode: 'confirmed' | 'uncertain' | 'loss' = 'confirmed'): VehiclePayloadPort {
  if (!['confirmed', 'uncertain', 'loss'].includes(mode)) throw new RangeError('Invalid modeled sampler outcome')
  const usedEvents = new Set<string>(), usedContainers = new Set<string>()
  let uncertain = false
  function hasActiveScope(context: VehicleControllerContext | null, command: VehiclePayloadCommand): boolean {
    const active = context?.mission.payload
    return !!context && context.enabled && context.mission.vehicle === 'surface' && context.mission.state === 'running'
      && context.mission.taskKind === 'payload' && context.mission.taskId === command.taskId
      && Number.isFinite(context.nowMs) && context.nowMs >= command.issuedAtMs && context.nowMs <= command.expiresAtMs
      && !!active && active.eventId === command.eventId && active.taskId === command.taskId
      && active.operation === command.operation && active.containerId === command.containerId && active.reference === command.reference
      && active.issuedAtMs === command.issuedAtMs && active.expiresAtMs === command.expiresAtMs
      && active.positionM.length === 3 && active.positionM.every((value, index) => value === command.positionM[index])
  }
  let pending: VehiclePayloadCommand | null = null, observed: VehicleControllerContext | null = null, closed = false, now = -Infinity
  return {
    observe(context) {
      if (closed) return
      observed = structuredClone(context)
      if (pending && !hasActiveScope(observed, pending)) uncertain = true
    },
    request(input) {
      if (closed || pending || input.operation !== 'water-sample' || !input.eventId || !input.taskId || !input.containerId || !/^[a-z0-9-]{1,48}$/i.test(input.containerId) || !input.reference || input.positionM.length !== 3 || input.positionM.some(v => !Number.isFinite(v)) || !Number.isFinite(input.issuedAtMs) || input.issuedAtMs < 0 || !Number.isFinite(input.expiresAtMs) || input.expiresAtMs - input.issuedAtMs < 200 || input.expiresAtMs - input.issuedAtMs > 10000 || usedEvents.has(input.eventId) || usedContainers.has(input.containerId)) throw new RangeError('Sampler command rejected: invalid scope, occupied or previously used container')
      pending = structuredClone(input); uncertain = !hasActiveScope(observed, pending); usedEvents.add(input.eventId); usedContainers.add(input.containerId)
    },
    poll(atMs) {
      if (!Number.isFinite(atMs) || atMs < now) throw new RangeError('Sampler clock must be monotonic')
      now = atMs
      if (closed || !pending || mode === 'loss' || atMs < pending.issuedAtMs + 200) return null
      const command = pending; pending = null
      let outcome: VehiclePayloadAck['outcome'] = mode === 'uncertain' || uncertain ? 'uncertain' : 'confirmed'
      const p = observed?.estimate.localPosition
      let position = p ? [...p.positionM] as [number, number, number] : [...command.positionM] as [number, number, number]
      try {
        if (!hasActiveScope(observed, command) || !observed || observed.nowMs !== atMs || !observed.estimate.health.localPosition || !p || observed.estimate.nowMs !== atMs || atMs > command.expiresAtMs || `${observed.estimate.bootId}:${Object.values(observed.estimate.resets).join(',')}` !== command.reference) throw new Error('Sampler observation lost')
        if (p.capturedAtMs === null || !Number.isFinite(p.capturedAtMs) || p.capturedAtMs > atMs || atMs - p.capturedAtMs > 200 || !Number.isFinite(p.predictedToMs) || p.predictedToMs > atMs || atMs - p.predictedToMs > 40 || p.positionM.length !== 3 || p.velocityMps.length !== 3 || [...p.positionM, ...p.velocityMps].some(n => !Number.isFinite(n))) throw new Error('Sampler position epoch unqualified')
        const m = qualifySurfaceMeasurement(observed.measurement, atMs, command.reference)
        if (!m.values.onSurface || !m.values.stopped || Math.hypot(...p.velocityMps) > 0.25 || Math.hypot(...position.map((n, i) => n - command.positionM[i]!)) > 0.4) throw new Error('Sampler moved outside capture envelope')
      }
      catch { outcome = 'uncertain'; position = [...command.positionM] }
      return { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, capturedAtMs: atMs, reference: command.reference, positionM: position, outcome, metadata: { evidence: 'modeled-sampler-ack', containerSealed: outcome === 'confirmed', physicalSampleVerified: false, recovery: outcome === 'confirmed' ? 'complete' : 'operator-inspect-container-before-new-event' } }
    },
    close() { closed = true; pending = null; observed = null },
  }
}
