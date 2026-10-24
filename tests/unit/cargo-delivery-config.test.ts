import { expect, test } from 'bun:test'
import { cargoDeliverySummary, simulateCargoDelivery } from '../../resources/functions/drone/cargo/delivery'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { planCargoDelivery } from '../../resources/functions/drone/cargo/plan'

const configuration = {
  version: 1,
  id: 'operator-cargo-route',
  delivery: { origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, site: { id: 'declared-site', recipientId: 'declared-recipient', containerId: 'parcel-150g', positionM: [2, 1, 0], radiusM: .4 }, releaseHeightM: 1.2 },
  load: { massKg: .15, forwardM: -.04 },
  alternateM: [-1, 1, 0],
  power: { availableWh: 50, maxW: 700, reservePercent: 35 },
}

// Existing public simulation seam: catches declared routes, actual loaded-body
// and sensor/authority/payload integration; misses physical flight qualification.
test('an explicit cargo configuration drives its own load, destination, release and return on the shared runtime', () => {
  const run = simulateCargoDelivery({ configuration })
  expect(run.status).toBe('completed')
  expect(run.delivery).toMatchObject({ outcome: 'received', containerId: 'parcel-150g', siteId: 'declared-site', recipientId: 'declared-recipient' })
  expect(run.initialLoad.properties.totalMassKg).toBe(1.65)
  expect(run.initialLoad.properties.cgBodyM[0]).toBeLessThan(0)
  expect(run.finalLoad.properties.totalMassKg).toBe(1.5)
  expect(run.release?.outcome).toBe('separated')
  expect(run.parcel?.massKg).toBe(.15)
  expect(run.parcel?.onSurface).toBe(true)
  expect(Math.hypot(run.parcel!.positionM[0] - 2, run.parcel!.positionM[1] - 1)).toBeLessThanOrEqual(.4)
  expect(run.runtime.trace.plan.id).toBe('operator-cargo-route')
  expect(run.runtime.trace.plan.power).toEqual(configuration.power)
  expect(run.runtime.trace.plan.tasks.find(task => task.id === 'site')).toMatchObject({ positionM: [2, 1, -1.2] })
  expect(run.runtime.trace.plan.tasks.find(task => task.id === 'alternate-land')).toMatchObject({ positionM: [-1, 1, 0] })
  expect(replayVehicleMission(run.runtime.trace).snapshot()).toEqual(run.runtime.mission)
  expect(run.runtime.board.actuators).toEqual([0, 0, 0, 0])
  const summary = cargoDeliverySummary(run)
  expect(summary.model).toMatchObject({ loadMassKg: .15, loadForwardM: -.04 })
  expect(summary.energy).toMatchObject({ capacityWh: 50, maximumDeclaredW: 700, reservePercent: 35, measured: false, electricalModel: false })
  expect(summary.demonstrationMatched).toBe(true)
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.identityAuthenticated).toBe(false)
}, 30000)

test('a blocked configured receiver retains its actual mass and lands at the explicitly declared alternate', () => {
  const run = simulateCargoDelivery({ configuration, scenario: 'site-blocked' })
  expect(run.status).toBe('diverted')
  expect(run.delivery.outcome).toBe('not-released')
  expect(run.release).toBeNull()
  expect(run.finalLoad.properties.totalMassKg).toBe(1.65)
  expect(run.runtime.mission.payloadFailure?.landingTaskId).toBe('alternate-land')
  expect(run.runtime.trace.rows.at(-1)!.observation.onGround).toBe(true)
  const landed = run.runtime.path.at(-1)!.truthPositionM
  expect(Math.hypot(landed[0] + 1, landed[1] - 1)).toBeLessThan(.18)
  expect(run.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(cargoDeliverySummary(run).demonstrationMatched).toBe(true)
}, 30000)

test('cargo planning captures a complete route and rejects unsupported geometry and unsafe budgets before execution', () => {
  const input = structuredClone(configuration), planned = planCargoDelivery(input)
  input.delivery.site.positionM[0] = 11; input.alternateM[0] = 10; input.load.massKg = .2
  expect(planned.configuration.delivery.site.positionM).toEqual([2, 1, 0])
  expect(planned.configuration.load.massKg).toBe(.15)
  expect(planned.mission.tasks.find(task => task.id === 'alternate-land')).toMatchObject({ positionM: [-1, 1, 0] })
  expect(planned.budget.worstCaseMs).toBe(81520)
  expect(planned.physicalFlightEnabled).toBe(false)
  expect(planned.identityAuthenticated).toBe(false)
  const lowBudget = structuredClone(configuration); lowBudget.power.availableWh = 1
  expect(() => planCargoDelivery(lowBudget)).toThrow()
  const farSite = structuredClone(configuration); farSite.delivery.site.positionM = [13, 0, 0]
  expect(() => planCargoDelivery(farSite)).toThrow()
  const farAlternate = structuredClone(configuration); farAlternate.alternateM = [13, 0, 0]
  expect(() => planCargoDelivery(farAlternate)).toThrow()
  const unmodeledOrigin = structuredClone(configuration); unmodeledOrigin.delivery.origin.latitudeDeg = 50
  expect(() => planCargoDelivery(unmodeledOrigin)).toThrow('cargo-delivery-configuration')
  const unmodeledSurface = structuredClone(configuration); unmodeledSurface.delivery.site.positionM[2] = -.2
  expect(() => planCargoDelivery(unmodeledSurface)).toThrow('cargo-delivery-configuration')
  const understatedPower = structuredClone(configuration); understatedPower.power.maxW = 50
  expect(() => planCargoDelivery(understatedPower)).toThrow('cargo-delivery-configuration')
  expect(() => simulateCargoDelivery({ configuration: undefined })).toThrow('cargo-delivery-input')
  let reads = 0
  const getter = { ...configuration, get alternateM() { reads++; return [-1, 1, 0] } }
  expect(() => planCargoDelivery(getter)).toThrow('cargo-delivery-configuration')
  expect(reads).toBe(0)
})

test('a configured route that never reaches the selected containment failure retains its actual completed outcome', () => {
  const near = structuredClone(configuration); near.delivery.site.positionM = [1, 0, 0]
  const run = simulateCargoDelivery({ configuration: near, scenario: 'authority-containment' })
  expect(run.status).toBe('completed')
  expect(run.delivery.outcome).toBe('received')
  expect(run.runtime.authority.events.some(event => event.reason === 'invalid-target-or-lease')).toBe(false)
  expect(cargoDeliverySummary(run).demonstrationMatched).toBe(false)
  expect(cargoDeliverySummary(run).landingContact).toBe(true)
}, 30000)
