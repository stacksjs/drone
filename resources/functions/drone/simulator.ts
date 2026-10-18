import type { Behavior, Decision, FlightAdapter, Target, Telemetry, Vector3 } from './types'
import { follow } from './behaviors'
import { decide } from './safety'
import { zero } from './geometry'

export function createSimulator(options: { behavior?: Behavior } = {}) {
  const customBehavior = options.behavior ? { ...options.behavior } : undefined
  let nowMs = 0
  let running = false
  let targetLost = false
  let batteryPercent = 98
  let distanceMeters = 10
  let altitudeMeters = 12
  let position: Vector3 = { north: -10, east: 0, down: -12 }
  let velocity = zero()
  let decision: Decision = { kind: 'release', reason: 'Simulation paused' }
  const trail: Vector3[] = []
  const events: { atMs: number, reason: string }[] = []

  const target = (): Target => ({
    id: 'pilot', position: { north: 15 * Math.sin(nowMs / 18000), east: 12 * Math.sin(nowMs / 26000), down: 0 },
    headingRadians: Math.atan2(12 / 26 * Math.cos(nowMs / 26000), 15 / 18 * Math.cos(nowMs / 18000)),
    confidence: 0.98, accuracyMeters: 1.5, receivedAtMs: targetLost ? -10000 : nowMs,
  })
  const telemetry = (): Telemetry => ({ position: { ...position }, velocity: { ...velocity }, batteryPercent, positionHealthy: true, mode: 'guided', armed: true, receivedAtMs: nowMs })
  const adapter: FlightAdapter = {
    kind: 'simulation', read: telemetry,
    send(next) { decision = next; velocity = next.kind === 'velocity' ? { ...next.velocity } : zero() },
    close() { running = false; velocity = zero() },
  }
  function snapshot() {
    return structuredClone({ mode: 'simulation' as const, running, nowMs, distanceMeters, altitudeMeters, targetLost, telemetry: telemetry(), target: target(), decision, trail, events })
  }
  return {
    adapter,
    snapshot,
    configure(options: { distanceMeters: number, altitudeMeters: number }) {
      if (!Number.isFinite(options.distanceMeters) || options.distanceMeters < 8 || options.distanceMeters > 25
        || !Number.isFinite(options.altitudeMeters) || options.altitudeMeters < 8 || options.altitudeMeters > 25)
        throw new RangeError('Distance and altitude must be between 8 and 25 metres')
      distanceMeters = options.distanceMeters
      altitudeMeters = options.altitudeMeters
      return snapshot()
    },
    command(command: 'start' | 'pause' | 'lose-target' | 'restore-target' | 'low-battery' | 'restore-battery') {
      if (command === 'start') running = true
      else if (command === 'pause') { running = false; velocity = zero(); decision = { kind: 'release', reason: 'Simulation paused' } }
      else if (command === 'lose-target') targetLost = true
      else if (command === 'restore-target') targetLost = false
      else if (command === 'low-battery') batteryPercent = 20
      else if (command === 'restore-battery') batteryPercent = 98
      else throw new TypeError('Unknown simulation command')
      return snapshot()
    },
    step(deltaMs = 200) {
      if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 1000) throw new RangeError('Invalid simulation step')
      if (!running) return snapshot()
      nowMs += deltaMs
      const next = decide({ telemetry: telemetry(), target: target(), targetId: 'pilot', enabled: true, nowMs, behavior: customBehavior ?? follow({ distanceMeters, altitudeMeters, gain: 0.7 }) })
      if (next.reason !== decision.reason) { events.unshift({ atMs: nowMs, reason: next.reason }); events.splice(20) }
      adapter.send(next)
      position = { north: position.north + velocity.north * deltaMs / 1000, east: position.east + velocity.east * deltaMs / 1000, down: position.down + velocity.down * deltaMs / 1000 }
      trail.push({ ...position }); if (trail.length > 120) trail.shift()
      return snapshot()
    },
  }
}

export type SimulationSnapshot = ReturnType<ReturnType<typeof createSimulator>['snapshot']>
