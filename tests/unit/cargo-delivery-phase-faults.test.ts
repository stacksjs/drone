import { expect, test } from 'bun:test'
import { cargoDeliverySummary, simulateCargoDelivery } from '../../resources/functions/drone/cargo/delivery'

test('host loss after observed separation leaves uncertain custody while the independent parcel and board keep evolving', () => {
  const run = simulateCargoDelivery({ scenario: 'after-release-host-loss' })
  expect(run.status).toBe('host-lost')
  expect(run.release?.outcome).toBe('separated')
  expect(run.finalLoad.properties.totalMassKg).toBe(1.5)
  expect(run.delivery.outcome).toBe('uncertain')
  expect(run.delivery.receiptCapturedAtMs).toBeNull()
  expect(run.parcel?.onSurface).toBe(true)
  expect(run.runtime.board.fault).toBe('output-lease-expired')
  expect(run.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(run.runtime.authority.state).toBe('autonomous')
  expect(run.runtime.mission.state).toBe('running')
  expect(run.runtime.trace.rows.some(row => row.result.reason === 'payload-confirmed')).toBe(false)
  const firstOpen = run.runtime.path.find(row => row.measurement?.values.mechanismOpen === true)!
  expect(run.faultInjection).toMatchObject({ phase: 'after-release', anchoredAtMs: firstOpen.atMs, sourceCapturedAtMs: firstOpen.measurement!.capturedAtMs, eventId: run.release!.eventId, triggeredAtMs: firstOpen.atMs + 20, independentTailMs: 1000 })
  expect(run.faultInjection!.finalPhysicalAtMs).toBeGreaterThan(run.runtime.authority.lastCheckedAtMs! + 1000)
  const summary = cargoDeliverySummary(run)
  expect(summary.authority.hostAvailable).toBe(false)
  expect(summary.demonstrationMatched).toBe(true)
  expect(summary.landingContact).toBe(false)
}, 30000)

for (const fault of ['position-loss', 'imu-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'both-links-loss']) test(`a post-separation ${fault} preserves uncertain custody and independent parcel motion`, () => {
  const run = simulateCargoDelivery({ scenario: 'after-release-' + fault })
  expect(run.status).toBe('blocked')
  expect(run.release?.outcome).toBe('separated')
  expect(run.delivery.outcome).toBe('uncertain')
  expect(run.delivery.receiptCapturedAtMs).toBeNull()
  expect(run.parcel?.onSurface).toBe(true)
  expect(run.parcel!.capturedAtMs).toBeGreaterThan(run.runtime.trace.rows.at(-1)!.observation.nowMs)
  expect(run.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(run.runtime.mission.state).not.toBe('completed')
  expect(run.runtime.trace.rows.some(row => row.result.reason === 'payload-confirmed')).toBe(false)
  const firstOpen = run.runtime.path.find(row => row.measurement?.values.mechanismOpen === true)!
  expect(run.faultInjection).toMatchObject({ anchoredAtMs: firstOpen.atMs, sourceCapturedAtMs: firstOpen.measurement!.capturedAtMs, eventId: run.release!.eventId, triggeredAtMs: firstOpen.atMs + 20 })
  const observed = run.runtime.authority.events
  expect(observed.some(event => fault === 'kill' ? event.to === 'killed' : fault === 'rc-override' ? event.to === 'manual' : fault === 'both-links-loss' ? event.reason === 'link-loss' : fault === 'position-loss' ? ['estimator-loss', 'stale-estimator'].includes(event.reason) : event.reason === 'stale-interlocks')).toBe(true)
  expect(cargoDeliverySummary(run).demonstrationMatched).toBe(true)
}, 30000)

for (const fault of ['host-loss', 'kill', 'position-loss']) test(`a post-receipt ${fault} preserves received custody without inventing carrier completion`, () => {
  const run = simulateCargoDelivery({ scenario: 'after-receipt-' + fault })
  expect(run.status).toBe(fault === 'host-loss' ? 'host-lost' : 'blocked')
  expect(run.delivery.outcome).toBe('received')
  expect(run.delivery.receiptCapturedAtMs).not.toBeNull()
  expect(run.release?.outcome).toBe('separated')
  expect(run.parcel?.onSurface).toBe(true)
  expect(run.runtime.trace.rows.filter(row => row.observation.payloadAck?.outcome === 'confirmed')).toHaveLength(1)
  const acknowledged = run.runtime.trace.rows.find(row => row.observation.payloadAck?.outcome === 'confirmed')!
  expect(run.faultInjection).toMatchObject({ phase: 'after-receipt', anchoredAtMs: acknowledged.observation.nowMs, sourceCapturedAtMs: acknowledged.observation.payloadAck!.capturedAtMs, eventId: acknowledged.observation.payloadAck!.eventId, triggeredAtMs: acknowledged.observation.nowMs + 20 })
  expect(run.delivery.receiptCapturedAtMs!).toBeGreaterThan(run.parcel!.capturedAtMs)
  expect(run.runtime.mission.state).not.toBe('completed')
  expect(run.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(cargoDeliverySummary(run).landingContact).toBe(false)
  expect(cargoDeliverySummary(run).demonstrationMatched).toBe(true)
}, 30000)
