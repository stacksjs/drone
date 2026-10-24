import type { SensorVector } from '../sensors/types'
import type { CargoBodySeparation, CargoLoadSnapshot } from './types'
import type { VehicleControllerContext, VehicleMissionPlan, VehiclePayloadCommand, VehiclePlant, VehicleSession } from '../vehicles/types'
import { createRigidBody } from '../controls/physics'
import { multirotorModel } from '../controls/model'
import { createMultirotorPlant, createMultirotorProfile } from '../vehicles/multirotor/profile'
import { runVehicleSimulation } from '../vehicles/runtime'
import { createRedundantVehicleLinks } from '../vehicles/links'
import type { CargoDeliveryCustody } from './coordinator'
import { createCargoDeliveryCoordinator } from './coordinator'

const flightFaults = ['position-loss', 'imu-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'host-loss'] as const
export const cargoDeliveryScenarios = ['nominal', 'recipient-absent', 'site-blocked', 'mechanism-jam', 'receipt-loss', 'foreign-receipt', 'primary-link-loss', 'both-links-loss', 'authority-containment', 'diversion-position-loss', 'diversion-kill', ...flightFaults] as const
type CargoDeliveryScenario = typeof cargoDeliveryScenarios[number]
interface Parcel { massKg: number, positionM: SensorVector, velocityMps: SensorVector, onSurface: boolean, capturedAtMs: number }
type DeliveryRelease = CargoBodySeparation & { atMs: number, eventId: string }
type DeliveryLinkSnapshot = ReturnType<ReturnType<typeof createRedundantVehicleLinks>['snapshot']>
export interface CargoDeliveryResult {
  version: 1
  evidence: 'owned-cargo-delivery-simulation'
  scenario: CargoDeliveryScenario
  status: ReturnType<typeof runVehicleSimulation>['status'] | 'diverted'
  physicalFlightEnabled: false
  boardOutputsInhibited: true
  identityAuthenticated: false
  delivery: CargoDeliveryCustody
  initialLoad: CargoLoadSnapshot
  finalLoad: CargoLoadSnapshot
  release: DeliveryRelease | null
  parcel: Parcel | null
  links: DeliveryLinkSnapshot
  linkEvents: DeliveryLinkSnapshot[]
  runtime: ReturnType<typeof runVehicleSimulation>
}
const site = Object.freeze({ id: 'fixture-receiver-site', recipientId: 'fixture-recipient', containerId: 'parcel-100g', northM: 3, eastM: 0, downM: 0, radiusM: .35 })
function inputScenario(input: unknown): CargoDeliveryScenario {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => key !== 'scenario')) throw new TypeError('cargo-delivery-input')
  const d = Object.getOwnPropertyDescriptor(input, 'scenario')
  if (d === undefined) return 'nominal'
  if (!d.enumerable || !Object.hasOwn(d, 'value') || !cargoDeliveryScenarios.some(value => value === d.value)) throw new TypeError('cargo-delivery-input')
  return d.value
}
function deliveryMission(): VehicleMissionPlan {
  const spatial = { acceptanceM: .18, maxArrivalSpeedMps: .15, settleMs: 300, timeoutMs: 20000 }
  return { version: 2, vehicle: 'quadcopter', id: 'cargo-shared-delivery', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5, maxDownM: 0 }, rallyM: [0, 0, -1],
    power: { availableWh: 40, maxW: 600, reservePercent: 30 }, start: 'start', tasks: [
      { id: 'start', kind: 'start', next: 'depart' },
      { id: 'depart', kind: 'takeoff', positionM: [0, 0, -1], ...spatial, next: 'site' },
      { id: 'site', kind: 'waypoint', positionM: [site.northM, site.eastM, -1], ...spatial, settleMs: 800, next: 'release' },
      { id: 'release', kind: 'payload', operation: 'material-drop', containerId: site.containerId, timeoutMs: 1500, next: 'home', onFailure: 'alternate-approach' },
      { id: 'home', kind: 'return', ...spatial, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], ...spatial },
      { id: 'alternate-approach', kind: 'waypoint', positionM: [1.5, -2, -1], ...spatial, next: 'alternate-land' },
      { id: 'alternate-land', kind: 'land', positionM: [1.5, -2, 0], ...spatial },
    ] }
}

/** Fictional local delivery with real modeled mass change and received, delayed evidence. No physical transport. */
export function simulateCargoDelivery(input: unknown = {}): CargoDeliveryResult {
  const scenario = inputScenario(input), flightScenario = flightFaults.find(value => value === scenario) ?? 'nominal'
  const profile = createMultirotorProfile(flightScenario), baseSession = profile.createSession, baseFaults = profile.faults
  profile.mission = deliveryMission()
  profile.scenario = scenario
  profile.scenarios = [...cargoDeliveryScenarios]
  profile.name = 'Owned modeled cargo delivery'
  if (scenario === 'authority-containment') profile.authorityFence = { ...profile.authorityFence, radiusM: 2 }
  profile.faults = (selected, atMs, phase) => {
    if (selected !== scenario) throw new TypeError('cargo-delivery-scenario-changed')
    const base = baseFaults(flightScenario, atMs, phase), failureAtMs = observed?.mission.payloadFailure?.triggeredAtMs
    const diversionFault = failureAtMs !== undefined && atMs >= failureAtMs + 200
    return { ...base, dropPosition: base.dropPosition || scenario === 'diversion-position-loss' && diversionFault, kill: base.kill || scenario === 'diversion-kill' && diversionFault }
  }
  const body = createRigidBody({ positionM: [0, 0, -.1], groundDownM: -.1, carriedPointLoad: { id: site.containerId, massKg: .1, forwardM: .08 } })
  const initialLoad = body.loadSnapshot(), adapted = createMultirotorPlant(body)
  let physicalAtMs = 600, parcel: Parcel | null = null, release: DeliveryRelease | null = null
  let armed: VehiclePayloadCommand | null = null, observed: VehicleControllerContext | null = null
  let receiptAtMs: number | null = null
  let mechanismAttempt: { eventId: string, atMs: number, jammed: boolean } | null = null
  const coordinator = createCargoDeliveryCoordinator({ origin: profile.mission.origin, site: { id: site.id, recipientId: site.recipientId, containerId: site.containerId, positionM: [site.northM, site.eastM, site.downM], radiusM: site.radiusM }, releaseHeightM: 1 }, {
    evidence: 'modeled-cargo-mechanism',
    request(command) { armed = structuredClone(command) },
    cancel(eventId) { if (armed?.eventId === eventId) armed = null },
  })
  const linkScope = { vehicleId: 'carrier-a', bootId: 55, sessionId: 123 }, linkMonitor = createRedundantVehicleLinks(linkScope)
  const linkQueue: { sourceId: 'primary' | 'backup', sequence: number, capturedAtMs: number, receivedAtMs: number }[] = [], linkEvents: DeliveryLinkSnapshot[] = []
  let links = linkMonitor.snapshot(0), linkSequence = 0
  function snapshot() {
    const state = adapted.snapshot(), load = body.loadSnapshot()
    return { ...state, details: { ...state.details, loadAttached: load.properties.phase === 'attached', loadMassKg: load.properties.totalMassKg } }
  }
  const plant: VehiclePlant = { snapshot, step(actuators, dtS, environment) {
    if (dtS !== .004) throw new RangeError('cargo-delivery-physical-step')
    adapted.step(actuators, dtS, environment)
    physicalAtMs += 4
    if (parcel && !parcel.onSurface) {
      parcel.velocityMps[2] += multirotorModel.gravityMps2 * dtS
      parcel.positionM = parcel.positionM.map((n, i) => n + parcel!.velocityMps[i]! * dtS) as SensorVector
      parcel.capturedAtMs = physicalAtMs
      if (parcel.positionM[2] >= site.downM) {
        parcel.positionM[2] = site.downM; parcel.velocityMps = [0, 0, 0]; parcel.onSurface = true
        if (Math.hypot(parcel.positionM[0] - site.northM, parcel.positionM[1] - site.eastM) <= site.radiusM) receiptAtMs = physicalAtMs
      }
    }
    if (armed && mechanismAttempt === null && physicalAtMs > armed.issuedAtMs) {
      if (physicalAtMs >= armed.expiresAtMs) { armed = null }
      else {
        mechanismAttempt = { eventId: armed.eventId, atMs: physicalAtMs, jammed: scenario === 'mechanism-jam' }
        if (mechanismAttempt.jammed) { armed = null; return snapshot() }
        const event = body.separateCarriedLoad()
        release = { ...event, atMs: physicalAtMs, eventId: armed.eventId }; armed = null
        if (event.outcome === 'separated') parcel = { ...event.parcel, onSurface: false, capturedAtMs: physicalAtMs }
      }
    }
    return snapshot()
  } }
  profile.createSession = (): VehicleSession => {
    const base = baseSession()
    return { ...base, createPlant: () => plant,
      linkObservation(nowMs) {
        linkSequence++
        for (const sourceId of ['primary', 'backup'] as const) {
          if (nowMs >= 5000 && (scenario === 'both-links-loss' || sourceId === 'primary' && scenario === 'primary-link-loss')) continue
          linkQueue.push({ sourceId, sequence: linkSequence, capturedAtMs: nowMs, receivedAtMs: nowMs + (sourceId === 'primary' ? 20 : 40) })
        }
        linkQueue.sort((a, b) => a.receivedAtMs - b.receivedAtMs)
        while (linkQueue[0] && linkQueue[0].receivedAtMs <= nowMs) {
          const packet = linkQueue.shift()!
          linkMonitor.ingest({ ...linkScope, ...packet, clockUncertaintyMs: 1, connected: true }, nowMs)
        }
        links = linkMonitor.snapshot(nowMs)
        const previous = linkEvents.at(-1)
        if (!previous || links.selectedSource !== previous.selectedSource || links.latchedLoss !== previous.latchedLoss) {
          if (linkEvents.length >= 16) throw new RangeError('cargo-link-events-exhausted')
          linkEvents.push(structuredClone(links))
        }
        return { ...links.authority }
      },
      observeIndependent(state, atMs) {
        if (atMs !== physicalAtMs) throw new RangeError('cargo-delivery-world-epoch')
        if (state.details.loadAttached !== (body.loadSnapshot().properties.phase === 'attached')) throw new TypeError('cargo-delivery-world-load')
      },
      renderMeasurement(state, atMs, reference) {
        const m = base.renderMeasurement(state, atMs, reference)
        const receiptCaptured = receiptAtMs !== null && atMs >= receiptAtMs + 100
        return { ...m, values: { ...m.values, loadAttached: state.details.loadAttached === true, loadMassKg: Number(state.details.loadMassKg), siteId: site.id, recipientId: receiptCaptured && scenario === 'foreign-receipt' ? 'fixture-other-recipient' : site.recipientId,
          siteClear: scenario !== 'site-blocked', recipientPresent: scenario !== 'recipient-absent' && !scenario.startsWith('diversion-'), mechanismOpen: release?.outcome === 'separated', mechanismJammed: mechanismAttempt?.jammed ?? false, mechanismEventId: mechanismAttempt?.eventId ?? '',
          receiptEventId: receiptCaptured && scenario !== 'receipt-loss' ? release?.eventId ?? '' : '', receiptContainerId: site.containerId } }
      },
      createPayload: () => ({ ...coordinator.port, observe(context) { observed = structuredClone(context); coordinator.port.observe!(context) } }),
    }
  }
  const runtime = runVehicleSimulation(profile, { seconds: 100 })
  const delivery = coordinator.snapshot().delivery
  return structuredClone({ version: 1, evidence: 'owned-cargo-delivery-simulation' as const, scenario, status: runtime.status === 'completed' && runtime.mission.payloadFailure ? 'diverted' as const : runtime.status, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, identityAuthenticated: false as const,
    delivery, initialLoad, finalLoad: body.loadSnapshot(), release, parcel, links, linkEvents, runtime })
}

/** A bounded command projection. Matches describe these model cases, never physical delivery. */
export function cargoDeliverySummary(run: CargoDeliveryResult) {
  const rt = run.runtime, power = rt.trace.plan.power, measurements = rt.path.flatMap(row => row.measurement ? [row.measurement] : [])
  const landingContact = rt.mission.state === 'completed' && rt.trace.rows.at(-1)?.observation.onGround === true
  const neutral = rt.board.actuators.length === 4 && rt.board.actuators.every(n => n === 0) && rt.board.expiresAtMs === null
    && (rt.authority.state === 'disarmed' || rt.authority.state === 'killed' || rt.authority.state === 'failsafe' || rt.status === 'host-lost' && rt.board.fault === 'output-lease-expired')
  const separationSeen = run.release?.outcome === 'separated' && run.finalLoad.properties.phase === 'separated' && measurements.some(m => m.values.loadAttached === false && m.values.loadMassKg === 1.5)
  const receiptEvent = run.release?.eventId
  let worldMatched = false
  if (run.scenario === 'nominal' || run.scenario === 'primary-link-loss') worldMatched = separationSeen && run.delivery.outcome === 'received' && run.status === 'completed'
    && (run.scenario !== 'primary-link-loss' || run.linkEvents.some(event => event.selectedSource === 'backup') && run.links.selectedSource === 'backup' && !run.links.latchedLoss)
  else if (run.scenario === 'recipient-absent') worldMatched = run.release === null && measurements.some(m => m.values.recipientPresent === false) && run.delivery.outcome === 'not-released'
  else if (run.scenario === 'site-blocked') worldMatched = run.release === null && measurements.some(m => m.values.siteClear === false) && run.delivery.outcome === 'not-released'
  else if (run.scenario === 'mechanism-jam') worldMatched = run.release === null && measurements.some(m => m.values.mechanismJammed === true) && run.delivery.mechanismOutcome === 'jammed'
  else if (run.scenario === 'receipt-loss') worldMatched = separationSeen && run.parcel?.onSurface === true && Math.hypot(run.parcel.positionM[0] - site.northM, run.parcel.positionM[1] - site.eastM) <= site.radiusM
    && measurements.every(m => m.values.receiptEventId === '') && run.delivery.outcome === 'uncertain'
  else if (run.scenario === 'foreign-receipt') worldMatched = separationSeen && measurements.some(m => m.values.recipientId === 'fixture-other-recipient' && m.values.receiptEventId === receiptEvent) && run.delivery.outcome === 'uncertain'
  else if (run.scenario === 'both-links-loss') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && run.links.latchedLoss && !run.links.authority.connected && rt.authority.events.some(event => event.reason === 'link-loss')
  else if (run.scenario === 'position-loss') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => ['estimator-loss', 'stale-estimator'].includes(event.reason))
  else if (run.scenario === 'imu-loss') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => event.reason === 'stale-interlocks') && rt.mission.reason === 'estimator-reference-changed'
  else if (run.scenario === 'vehicle-sensor-loss') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => event.reason === 'stale-interlocks')
  else if (run.scenario === 'rc-override') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => event.to === 'manual' && event.reason === 'rc-override')
  else if (run.scenario === 'kill') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.state === 'killed'
  else if (run.scenario === 'host-loss') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.lastCheckedAtMs === 4980 && rt.board.fault === 'output-lease-expired'
  else if (run.scenario === 'authority-containment') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => event.reason === 'invalid-target-or-lease') && rt.path.every(row => Math.hypot(row.truthPositionM[0], row.truthPositionM[1]) <= 2)
  else if (run.scenario.startsWith('diversion-')) worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.mission.payloadFailure?.reason === 'rejected'
    && rt.authority.events.some(event => event.atMs !== null && event.atMs >= rt.mission.payloadFailure!.triggeredAtMs + 200 && (run.scenario === 'diversion-kill' ? event.to === 'killed' : ['estimator-loss', 'stale-estimator'].includes(event.reason)))
  const expectedStatus = run.scenario === 'nominal' || run.scenario === 'primary-link-loss' ? 'completed' : run.scenario === 'host-loss' ? 'host-lost' : run.scenario === 'both-links-loss' || run.scenario === 'authority-containment' || run.scenario.startsWith('diversion-') || flightFaults.some(value => value === run.scenario) ? 'blocked' : 'diverted'
  const summary = structuredClone({ version: 1, evidence: run.evidence, scenario: run.scenario, status: run.status, demonstrationMatched: worldMatched && run.status === expectedStatus && (!['completed', 'diverted'].includes(expectedStatus) || landingContact) && neutral,
    physicalFlightEnabled: false, boardOutputsInhibited: true, identityAuthenticated: false, delivery: run.delivery, landingContact,
    load: { initial: run.initialLoad.properties, final: run.finalLoad.properties },
    release: run.release ? { atMs: run.release.atMs, eventId: run.release.eventId, outcome: run.release.outcome, reason: run.release.reason } : null,
    parcel: run.parcel, links: run.links, linkEvents: run.linkEvents,
    mission: { state: rt.mission.state, taskId: rt.mission.taskId, reason: rt.mission.reason, payloadFailure: rt.mission.payloadFailure ?? null, traceRows: rt.trace.rows.length },
    energy: { evidence: 'declared-mission-power-budget', measured: false, electricalModel: false, capacityWh: power.availableWh, maximumDeclaredW: power.maxW, reservePercent: power.reservePercent,
      worstCaseMs: rt.budget.worstCaseMs, worstCaseRequiredWh: rt.budget.requiredWh, marginAboveReserveWh: power.availableWh * (1 - power.reservePercent / 100) - rt.budget.requiredWh },
    board: { actuators: [...rt.board.actuators], expiresAtMs: rt.board.expiresAtMs, fault: rt.board.fault, physicalActuationEnabled: rt.board.physicalActuationEnabled },
    authority: { hostAvailable: rt.status !== 'host-lost', state: rt.authority.state, reason: rt.authority.reason, lastCheckedAtMs: rt.authority.lastCheckedAtMs, leaseUntilMs: rt.authority.leaseUntilMs },
    model: { loadMassKg: .1, loadForwardM: .08, separation: 'zero-ejection-point-mass', parcel: 'ballistic-point-with-plane-capture', receiver: 'fictional-100ms-receipt', measurementDelayMs: 40, headingAlignment: 'initial-simulation-north' },
  })
  if (new TextEncoder().encode(JSON.stringify(summary)).byteLength + 1 > 16384) throw new RangeError('cargo-delivery-summary-unavailable')
  return summary
}
