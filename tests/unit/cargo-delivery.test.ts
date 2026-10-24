import { expect, test } from 'bun:test'
import { cargoDeliverySummary, simulateCargoDelivery } from '../../resources/functions/drone/cargo/delivery'
import { replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Public delivery simulation: actual mass/CG plant, raw navigation, commanded
// mechanism, delayed model observations and mission replay. No physical IO.
test('a simulated parcel is released and received before the carrier returns and lands', () => {
  const result = simulateCargoDelivery()
  expect(result.evidence).toBe('owned-cargo-delivery-simulation')
  expect(result.status).toBe('completed')
  expect(result.delivery.outcome).toBe('received')
  expect(result.initialLoad.properties.totalMassKg).toBe(1.6)
  expect(result.finalLoad.properties.totalMassKg).toBe(1.5)
  expect(result.release?.outcome).toBe('separated')
  expect(result.delivery.mechanismCapturedAtMs).toBeGreaterThan(result.delivery.requestedAtMs!)
  expect(result.delivery.receiptCapturedAtMs).toBeGreaterThan(result.delivery.mechanismCapturedAtMs!)
  expect(result.parcel?.onSurface).toBe(true)
  expect(result.runtime.mission.state).toBe('completed')
  expect(replayVehicleMission(result.runtime.trace).snapshot()).toEqual(result.runtime.mission)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(result.physicalFlightEnabled).toBe(false)
  expect(result.identityAuthenticated).toBe(false)
}, 30000)

test('mechanism and receiver observations retain the executed command after its acknowledgement', () => {
  const result = simulateCargoDelivery()
  const request = result.runtime.trace.rows.find(row => row.result.payload !== null)!.result.payload!
  const later = result.runtime.path.filter(row => row.atMs > result.delivery.acknowledgedAtMs! + 100)
  expect(later.length).toBeGreaterThan(10)
  for (const row of later) {
    expect(row.measurement?.values.mechanismEventId).toBe(request.eventId)
    expect(row.measurement?.values.receiptEventId).toBe(request.eventId)
    expect(row.measurement?.values.loadAttached).toBe(false)
  }
}, 30000)

for (const scenario of ['recipient-absent', 'site-blocked']) {
  test('a delivery cannot release without current ' + scenario + ' evidence', () => {
    const result = simulateCargoDelivery({ scenario })
    expect(result.status).toBe('diverted')
    expect(result.delivery.outcome).toBe('not-released')
    expect(result.delivery.reason).toBe('release-evidence-unqualified')
    expect(result.release).toBeNull()
    expect(result.finalLoad.properties.totalMassKg).toBe(1.6)
    expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
    expect(result.runtime.mission.reason).toBe('payload-diversion-landed')
  }, 30000)
}

test('a captured mechanism jam refuses delivery without separating the actual carried mass', () => {
  const result = simulateCargoDelivery({ scenario: 'mechanism-jam' })
  expect(result.status).toBe('diverted')
  expect(result.delivery.outcome).toBe('not-released')
  expect(result.delivery.reason).toBe('mechanism-jammed')
  expect(result.release).toBeNull()
  expect(result.finalLoad.properties.totalMassKg).toBe(1.6)
  const acknowledgements = result.runtime.trace.rows.flatMap(row => row.observation.payloadAck ? [row.observation.payloadAck] : [])
  expect(acknowledgements).toHaveLength(1)
  expect(acknowledgements[0]!.outcome).toBe('rejected')
  expect(acknowledgements[0]!.capturedAtMs).toBe(result.delivery.mechanismCapturedAtMs!)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
}, 30000)

for (const scenario of ['receipt-loss', 'foreign-receipt']) {
  test('a separated parcel remains uncertain under ' + scenario, () => {
    const result = simulateCargoDelivery({ scenario })
    expect(result.status).toBe('diverted')
    expect(result.release?.outcome).toBe('separated')
    expect(result.finalLoad.properties.totalMassKg).toBe(1.5)
    expect(result.delivery.mechanismOutcome).toBe('open')
    expect(result.delivery.outcome).toBe('uncertain')
    expect(result.delivery.receiptCapturedAtMs).toBeNull()
    expect(result.runtime.mission.reason).toBe('payload-diversion-landed')
    expect(result.runtime.trace.rows.some(row => row.result.reason === 'payload-confirmed')).toBe(false)
    expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
  }, 30000)
}


test('a refused release takes only the declared finite alternate and lands without claiming delivery', () => {
  const result = simulateCargoDelivery({ scenario: 'site-blocked' })
  expect(result.status).toBe('diverted')
  expect(result.delivery.outcome).toBe('not-released')
  expect(result.runtime.mission.state).toBe('completed')
  expect(result.runtime.mission.payloadFailure?.taskId).toBe('release')
  expect(result.runtime.mission.payloadFailure?.reason).toBe('rejected')
  expect(result.runtime.mission.payloadFailure?.landingTaskId).toBe('alternate-land')
  expect(result.runtime.trace.rows.at(-1)!.observation.onGround).toBe(true)
  expect(result.runtime.path.some(row => row.mission.taskId === 'home')).toBe(false)
  expect(result.runtime.trace.rows.filter(row => row.result.payload !== null).map(row => row.result.payload!.eventId).every(id => id === result.runtime.mission.payloadFailure!.eventId)).toBe(true)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(replayVehicleMission(result.runtime.trace).snapshot()).toEqual(result.runtime.mission)
}, 30000)


test('declared reserve planning includes the entire alternate route before execution', () => {
  const plan = simulateCargoDelivery().runtime.trace.plan
  const approach = plan.tasks.find(task => task.id === 'alternate-approach')!
  const land = plan.tasks.find(task => task.id === 'alternate-land')!
  Object.assign(approach, { timeoutMs: 60000 })
  Object.assign(land, { timeoutMs: 60000 })
  const budget = validateVehicleMission(plan)
  // 20 ms start + 20 s takeoff + 20 s site + 1.5 s release + two 60 s alternate tasks.
  expect(budget.worstCaseMs).toBe(161520)
  expect(budget.requiredWh).toBe(26.92)
  plan.power.availableWh = 30
  // Normal return fits 21 Wh usable, while the declared failure path does not.
  expect(() => validateVehicleMission(plan)).toThrow('Vehicle mission cannot preserve energy reserve')
}, 30000)

test('a payload failure route cannot request another release or move its declared landing site', () => {
  const plan = simulateCargoDelivery().runtime.trace.plan
  const releaseAgain = structuredClone(plan)
  releaseAgain.tasks[releaseAgain.tasks.findIndex(task => task.id === 'alternate-approach')] = { id: 'alternate-approach', kind: 'payload', operation: 'material-drop', containerId: 'another-parcel', timeoutMs: 1000, next: 'alternate-land' }
  expect(() => validateVehicleMission(releaseAgain)).toThrow('Invalid vehicle mission')
  const wrongSite = structuredClone(plan), land = wrongSite.tasks.find(task => task.id === 'alternate-land')!
  if (land.kind !== 'land') throw new Error('Expected declared landing')
  land.positionM[0] = 2
  expect(() => validateVehicleMission(wrongSite)).toThrow('Invalid vehicle mission')
}, 30000)

test('delivery acknowledgement positions belong to the captured receiver packet epoch', () => {
  const result = simulateCargoDelivery()
  const row = result.runtime.trace.rows.find(row => row.observation.payloadAck !== null)!
  const ack = row.observation.payloadAck!
  const received = result.runtime.path.find(path => path.atMs === row.observation.nowMs)!
  expect(received.measurement!.capturedAtMs).toBe(ack.capturedAtMs)
  expect(received.measurementPose!.capturedAtMs).toBe(ack.capturedAtMs)
  expect(ack.positionM).toEqual(received.measurementPose!.positionM)
  expect(received.atMs - ack.capturedAtMs).toBe(40)
}, 30000)

test('a delivery continues on its captured backup link without changing vehicle authority or custody', () => {
  const result = simulateCargoDelivery({ scenario: 'primary-link-loss' })
  expect(result.status).toBe('completed')
  expect(result.delivery.outcome).toBe('received')
  const failover = result.linkEvents.find(event => event.selectedSource === 'backup')!
  expect(failover).toBeDefined()
  expect(failover.observedAtMs).toBeGreaterThan(5000)
  expect(failover.authority.capturedAtMs).toBeLessThan(failover.observedAtMs)
  expect(failover.sources.find(source => source.sourceId === 'primary')!.capturedAtMs).toBe(4980)
  expect(result.links.selectedSource).toBe('backup')
  expect(result.links.latchedLoss).toBe(false)
  expect(result.links.scope).toEqual({ vehicleId: 'carrier-a', bootId: 55, sessionId: 123 })
  expect(result.runtime.authority.bootId).toBe(55n)
  expect(result.runtime.authority.sessionId).toBe(123n)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
}, 30000)

test('loss of both delivery links latches loss and revokes the carrier before release', () => {
  const result = simulateCargoDelivery({ scenario: 'both-links-loss' })
  expect(result.status).toBe('blocked')
  expect(result.links.latchedLoss).toBe(true)
  expect(result.links.authority.connected).toBe(false)
  expect(result.delivery.outcome).toBe('not-released')
  expect(result.release).toBeNull()
  expect(result.runtime.mission.state).not.toBe('completed')
  expect(result.runtime.authority.events.some(event => event.reason === 'link-loss')).toBe(true)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(result.runtime.board.expiresAtMs).toBeNull()
  expect(replayVehicleMission(result.runtime.trace).snapshot()).toEqual(result.runtime.mission)
}, 30000)

test('degraded delivery navigation revokes authority without releasing the parcel', () => {
  const result = simulateCargoDelivery({ scenario: 'position-loss' })
  expect(result.status).toBe('blocked')
  expect(result.delivery.outcome).toBe('not-released')
  expect(result.release).toBeNull()
  expect(result.runtime.authority.events.some(event => ['estimator-loss', 'stale-estimator'].includes(event.reason))).toBe(true)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(result.runtime.board.expiresAtMs).toBeNull()
}, 30000)

for (const scenario of ['imu-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'host-loss']) {
  test('delivery retains cargo and neutral output under ' + scenario, () => {
    const result = simulateCargoDelivery({ scenario })
    expect(result.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
    expect(result.delivery.outcome).toBe('not-released')
    expect(result.release).toBeNull()
    expect(result.runtime.mission.state).not.toBe('completed')
    expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
    expect(result.runtime.board.expiresAtMs).toBeNull()
    expect(cargoDeliverySummary(result).demonstrationMatched).toBe(true)
    if (scenario === 'host-loss') {
      expect(result.runtime.board.fault).toBe('output-lease-expired')
      expect(result.runtime.authority.state).toBe('autonomous')
    }
    if (scenario === 'rc-override') expect(result.runtime.authority.events.some(event => event.to === 'manual')).toBe(true)
    if (scenario === 'kill') expect(result.runtime.authority.events.some(event => event.to === 'killed')).toBe(true)
  }, 30000)
}

test('a delivery target outside the independent authority fence cannot escape containment', () => {
  const result = simulateCargoDelivery({ scenario: 'authority-containment' })
  expect(result.status).toBe('blocked')
  expect(result.release).toBeNull()
  expect(result.delivery.outcome).toBe('not-released')
  expect(result.runtime.authority.events.some(event => event.reason === 'invalid-target-or-lease')).toBe(true)
  expect(result.runtime.path.every(row => Math.hypot(row.truthPositionM[0], row.truthPositionM[1]) <= 2)).toBe(true)
  expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
}, 30000)

for (const scenario of ['diversion-position-loss', 'diversion-kill']) {
  test('an alternate route cannot override ' + scenario, () => {
    const result = simulateCargoDelivery({ scenario })
    expect(result.status).toBe('blocked')
    expect(result.runtime.mission.payloadFailure?.reason).toBe('rejected')
    expect(result.runtime.mission.state).not.toBe('completed')
    expect(result.delivery.outcome).toBe('not-released')
    expect(result.release).toBeNull()
    const failureAtMs = result.runtime.mission.payloadFailure!.triggeredAtMs
    expect(result.runtime.path.some(row => row.atMs > failureAtMs && row.atMs < failureAtMs + 200 && row.mission.taskId === 'alternate-approach' && row.actuators.some(n => n > 0))).toBe(true)
    expect(result.runtime.board.actuators).toEqual([0, 0, 0, 0])
    expect(result.runtime.board.expiresAtMs).toBeNull()
    if (scenario === 'diversion-kill') expect(result.runtime.authority.state).toBe('killed')
    else expect(result.runtime.authority.events.some(event => ['estimator-loss', 'stale-estimator'].includes(event.reason))).toBe(true)
    expect(replayVehicleMission(result.runtime.trace).snapshot()).toEqual(result.runtime.mission)
  }, 30000)
}
