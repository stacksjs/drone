import { expect, test } from 'bun:test'
import { createRedundantVehicleLinks } from '../../resources/functions/drone/vehicles/links'

// Public captured-link adapter: modeled scope, source time and latched loss.
// This does not verify radios, clock synchronization or authenticated identity.
test('a fresh backup preserves the same authority scope when the primary becomes stale', () => {
  const scope = { vehicleId: 'carrier-a', bootId: 55, sessionId: 123 }
  const links = createRedundantVehicleLinks(scope)
  expect(links.snapshot(0).selectedSource).toBeNull()
  expect(links.ingest({ ...scope, sourceId: 'primary', sequence: 1, capturedAtMs: 10, receivedAtMs: 30, clockUncertaintyMs: 2, connected: true }, 30)).toBe(true)
  expect(links.snapshot(30).selectedSource).toBe('primary')
  expect(links.ingest({ ...scope, sourceId: 'backup', sequence: 1, capturedAtMs: 100, receivedAtMs: 120, clockUncertaintyMs: 2, connected: true }, 120)).toBe(true)
  const failover = links.snapshot(162)
  expect(failover.selectedSource).toBe('backup')
  expect(failover.authority).toEqual({ capturedAtMs: 98, connected: true })
  expect(failover.scope).toEqual(scope)
  expect(failover.latchedLoss).toBe(false)
})

test('fresh packets cannot silently restore a scope after both sources have expired', () => {
  const scope = { vehicleId: 'carrier-a', bootId: 55, sessionId: 123 }
  const links = createRedundantVehicleLinks(scope)
  const first = { ...scope, sourceId: 'primary', sequence: 1, capturedAtMs: 10, receivedAtMs: 30, clockUncertaintyMs: 2, connected: true }
  expect(links.ingest(first, 30)).toBe(true)
  expect(links.snapshot(30).authority.connected).toBe(true)
  // No intervening snapshot is required to notice the lost interval.
  expect(links.ingest({ ...first, sequence: 2, capturedAtMs: 190, receivedAtMs: 210 }, 210)).toBe(false)
  expect(links.snapshot(210).latchedLoss).toBe(true)
  expect(links.snapshot(210).authority.connected).toBe(false)
})

test('foreign, replayed, future, uncertain and executable link envelopes cannot refresh the captured source', () => {
  const scope = { vehicleId: 'carrier-a', bootId: 55, sessionId: 123 }, links = createRedundantVehicleLinks(scope)
  const packet = { ...scope, sourceId: 'primary', sequence: 1, capturedAtMs: 20, receivedAtMs: 40, clockUncertaintyMs: 2, connected: true }
  expect(links.ingest(packet, 40)).toBe(true)
  let accessed = false
  const getter = { ...packet, sequence: 2 }
  Object.defineProperty(getter, 'capturedAtMs', { enumerable: true, get() { accessed = true; return 60 } })
  for (const invalid of [packet, { ...packet, vehicleId: 'carrier-b', sequence: 2 }, { ...packet, bootId: 56, sequence: 2 }, { ...packet, sessionId: 124, sequence: 2 },
    { ...packet, sourceId: 'third', sequence: 2 }, { ...packet, sequence: 2, capturedAtMs: 60, receivedAtMs: 80 }, { ...packet, sequence: 2, receivedAtMs: 70 },
    { ...packet, sequence: 2, clockUncertaintyMs: 11 }, { ...packet, sequence: 2, unknown: true }, getter]) {
    expect(links.ingest(invalid, 60)).toBe(false)
  }
  expect(accessed).toBe(false)
  expect(links.snapshot(60).authority).toEqual({ capturedAtMs: 18, connected: true })
  expect(links.snapshot(168).authority.connected).toBe(true)
  expect(links.snapshot(169).latchedLoss).toBe(true)
})

test('a disconnected primary uses the backup without taking a new authority session', () => {
  const scope = { vehicleId: 'carrier-a', bootId: 55, sessionId: 123 }, links = createRedundantVehicleLinks(scope)
  for (const sourceId of ['primary', 'backup']) expect(links.ingest({ ...scope, sourceId, sequence: 1, capturedAtMs: 20, receivedAtMs: 40, clockUncertaintyMs: 2, connected: true }, 40)).toBe(true)
  expect(links.snapshot(40).selectedSource).toBe('primary')
  expect(links.ingest({ ...scope, sourceId: 'primary', sequence: 2, capturedAtMs: 60, receivedAtMs: 80, clockUncertaintyMs: 2, connected: false }, 80)).toBe(true)
  const result = links.snapshot(80)
  expect(result.selectedSource).toBe('backup')
  expect(result.authority.capturedAtMs).toBe(18)
  expect(result.scope).toEqual(scope)
  expect(result.identityAuthenticated).toBe(false)
  expect(() => links.snapshot(79)).toThrow('Invalid vehicle link clock')
})

test('link ownership requires captured scalar vehicle, boot and session identities', () => {
  expect(() => createRedundantVehicleLinks({ vehicleId: undefined as unknown as string, bootId: 55, sessionId: 123 })).toThrow('Invalid vehicle link scope')
  let accessed = false
  const input = { bootId: 55, sessionId: 123, get vehicleId() { accessed = true; return 'carrier-a' } }
  expect(() => createRedundantVehicleLinks(input)).toThrow('Invalid vehicle link scope')
  expect(accessed).toBe(false)
})
