import type { SensorVector } from '../sensors/types'
import type { CargoBodySeparation, CargoLoadSnapshot } from './types'
import type { VehicleControllerContext, VehiclePayloadCommand, VehiclePlant, VehicleSession } from '../vehicles/types'
import { createRigidBody } from '../controls/physics'
import { multirotorModel } from '../controls/model'
import { createMultirotorPlant, createMultirotorProfile } from '../vehicles/multirotor/profile'
import { runVehicleSimulation } from '../vehicles/runtime'
import { createRedundantVehicleLinks } from '../vehicles/links'
import type { CargoDeliveryConfiguration } from './plan'
import { planCargoDelivery } from './plan'
import type { CargoDeliveryCustody } from './coordinator'
import { createCargoDeliveryCoordinator } from './coordinator'

const flightFaults = ['position-loss', 'imu-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'host-loss'] as const
const phaseFaultDefinitions = {
  'after-release-host-loss': { phase: 'after-release', fault: 'hostLost' },
  'after-release-position-loss': { phase: 'after-release', fault: 'dropPosition' },
  'after-release-imu-loss': { phase: 'after-release', fault: 'dropImu' },
  'after-release-vehicle-sensor-loss': { phase: 'after-release', fault: 'dropVehicleSensor' },
  'after-release-rc-override': { phase: 'after-release', fault: 'rcOverride' },
  'after-release-kill': { phase: 'after-release', fault: 'kill' },
  'after-release-both-links-loss': { phase: 'after-release', fault: 'links' },
  'after-receipt-host-loss': { phase: 'after-receipt', fault: 'hostLost' },
  'after-receipt-kill': { phase: 'after-receipt', fault: 'kill' },
  'after-receipt-position-loss': { phase: 'after-receipt', fault: 'dropPosition' },
} as const
const phaseFaults = Object.keys(phaseFaultDefinitions) as (keyof typeof phaseFaultDefinitions)[]
function phaseFault(scenario: string) { return Object.hasOwn(phaseFaultDefinitions, scenario) ? phaseFaultDefinitions[scenario as keyof typeof phaseFaultDefinitions] : null }
export const cargoDeliveryScenarios = ['nominal', 'recipient-absent', 'site-blocked', 'mechanism-jam', 'receipt-loss', 'foreign-receipt', 'primary-link-loss', 'both-links-loss', 'authority-containment', 'diversion-position-loss', 'diversion-kill', ...flightFaults, ...phaseFaults] as const
type CargoDeliveryScenario = typeof cargoDeliveryScenarios[number]
interface Parcel { massKg: number, positionM: SensorVector, velocityMps: SensorVector, onSurface: boolean, capturedAtMs: number }
type DeliveryRelease = CargoBodySeparation & { atMs: number, eventId: string }
type DeliveryLinkSnapshot = ReturnType<ReturnType<typeof createRedundantVehicleLinks>['snapshot']>
interface DeliveryFaultInjection { phase: 'after-release' | 'after-receipt', anchoredAtMs: number | null, sourceCapturedAtMs: number | null, eventId: string | null, triggeredAtMs: number | null, independentTailMs: number, finalPhysicalAtMs: number }
export interface CargoDeliveryResult {
  version: 1
  evidence: 'owned-cargo-delivery-simulation'
  scenario: CargoDeliveryScenario
  status: ReturnType<typeof runVehicleSimulation>['status'] | 'diverted'
  physicalFlightEnabled: false
  boardOutputsInhibited: true
  identityAuthenticated: false
  faultInjection?: DeliveryFaultInjection
  configuration?: CargoDeliveryConfiguration
  delivery: CargoDeliveryCustody
  initialLoad: CargoLoadSnapshot
  finalLoad: CargoLoadSnapshot
  release: DeliveryRelease | null
  parcel: Parcel | null
  links: DeliveryLinkSnapshot
  linkEvents: DeliveryLinkSnapshot[]
  runtime: ReturnType<typeof runVehicleSimulation>
}
const fixtureConfiguration: CargoDeliveryConfiguration = { version: 1, id: 'cargo-shared-delivery', delivery: { origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, site: { id: 'fixture-receiver-site', recipientId: 'fixture-recipient', containerId: 'parcel-100g', positionM: [3, 0, 0], radiusM: .35 }, releaseHeightM: 1 }, load: { massKg: .1, forwardM: .08 }, alternateM: [1.5, -2, 0], power: { availableWh: 40, maxW: 600, reservePercent: 30 } }
function captureInput(input: unknown) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => key !== 'scenario' && key !== 'configuration')) throw new TypeError('cargo-delivery-input')
  const d = Object.getOwnPropertyDescriptor(input, 'scenario'), config = Object.getOwnPropertyDescriptor(input, 'configuration')
  if (d && (!d.enumerable || !Object.hasOwn(d, 'value') || !cargoDeliveryScenarios.some(value => value === d.value)) || config && (!config.enumerable || !Object.hasOwn(config, 'value') || config.value === undefined)) throw new TypeError('cargo-delivery-input')
  return { scenario: (d?.value ?? 'nominal') as CargoDeliveryScenario, explicit: !!config, planned: planCargoDelivery(config ? config.value : fixtureConfiguration) }
}

/** Fictional local delivery with real modeled mass change and received, delayed evidence. No physical transport. */
export function simulateCargoDelivery(input: unknown = {}): CargoDeliveryResult {
  const captured = captureInput(input), { scenario, planned } = captured, configuration = planned.configuration
  const selectedSite = configuration.delivery.site
  const site = { ...selectedSite, northM: selectedSite.positionM[0], eastM: selectedSite.positionM[1], downM: selectedSite.positionM[2] }
  const flightScenario = flightFaults.find(value => value === scenario) ?? 'nominal'
  const selectedFault = phaseFault(scenario)
  const faultInjection: DeliveryFaultInjection | null = selectedFault ? { phase: selectedFault.phase, anchoredAtMs: null, sourceCapturedAtMs: null, eventId: null, triggeredAtMs: null, independentTailMs: 1000, finalPhysicalAtMs: 0 } : null
  const profile = createMultirotorProfile(flightScenario), baseSession = profile.createSession, baseFaults = profile.faults
  profile.mission = planned.mission
  profile.scenario = scenario
  profile.scenarios = [...cargoDeliveryScenarios]
  profile.name = 'Owned modeled cargo delivery'
  if (scenario === 'authority-containment') profile.authorityFence = { ...profile.authorityFence, radiusM: 2 }
  profile.faults = (selected, atMs, phase) => {
    if (selected !== scenario) throw new TypeError('cargo-delivery-scenario-changed')
    const base = baseFaults(flightScenario, atMs, phase), failureAtMs = observed?.mission.payloadFailure?.triggeredAtMs
    const diversionFault = failureAtMs !== undefined && atMs >= failureAtMs + 200
    if (phase === 'host' && faultInjection && faultInjection.anchoredAtMs !== null && atMs >= faultInjection.anchoredAtMs + 20) faultInjection.triggeredAtMs ??= atMs
    const phaseActive = faultInjection !== null && faultInjection.triggeredAtMs !== null && atMs >= faultInjection.triggeredAtMs
    const fault = phaseActive ? selectedFault?.fault : null
    return { ...base, dropPosition: base.dropPosition || scenario === 'diversion-position-loss' && diversionFault || fault === 'dropPosition', kill: base.kill || scenario === 'diversion-kill' && diversionFault || fault === 'kill',
      hostLost: base.hostLost || fault === 'hostLost', dropImu: base.dropImu || fault === 'dropImu', dropVehicleSensor: base.dropVehicleSensor || fault === 'dropVehicleSensor', rcOverride: base.rcOverride || fault === 'rcOverride' }
  }
  const body = createRigidBody({ positionM: [0, 0, -.1], groundDownM: -.1, carriedPointLoad: { id: site.containerId, ...configuration.load } })
  const initialLoad = body.loadSnapshot(), adapted = createMultirotorPlant(body)
  let physicalAtMs = 600, parcel: Parcel | null = null, release: DeliveryRelease | null = null
  let armed: VehiclePayloadCommand | null = null, observed: VehicleControllerContext | null = null
  let receiptAtMs: number | null = null
  let mechanismAttempt: { eventId: string, atMs: number, jammed: boolean } | null = null
  const coordinator = createCargoDeliveryCoordinator(configuration.delivery, {
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
          if (nowMs >= 5000 && (scenario === 'both-links-loss' || sourceId === 'primary' && scenario === 'primary-link-loss')
            || selectedFault?.fault === 'links' && faultInjection && faultInjection.triggeredAtMs !== null && nowMs >= faultInjection.triggeredAtMs) continue
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
      createPayload: () => ({ ...coordinator.port, observe(context) { observed = structuredClone(context); coordinator.port.observe!(context) }, poll(nowMs) {
        const ack = coordinator.port.poll(nowMs)
        if (faultInjection && faultInjection.anchoredAtMs === null) {
          const custody = coordinator.snapshot().delivery
          const capturedAtMs = faultInjection.phase === 'after-receipt' ? custody.outcome === 'received' ? custody.receiptCapturedAtMs : null : custody.mechanismOutcome === 'open' ? custody.mechanismCapturedAtMs : null
          const eventId = observed?.measurement?.values[faultInjection.phase === 'after-receipt' ? 'receiptEventId' : 'mechanismEventId']
          if (capturedAtMs !== null && typeof eventId === 'string' && eventId.length > 0) {
            faultInjection.anchoredAtMs = nowMs; faultInjection.sourceCapturedAtMs = capturedAtMs; faultInjection.eventId = eventId
          }
        }
        return ack
      } }),
    }
  }
  const runtime = runVehicleSimulation(profile, { seconds: 100, neutralTailMs: faultInjection?.independentTailMs ?? 0 })
  const delivery = coordinator.snapshot().delivery
  return structuredClone({ version: 1, evidence: 'owned-cargo-delivery-simulation' as const, scenario, status: runtime.status === 'completed' && runtime.mission.payloadFailure ? 'diverted' as const : runtime.status, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, identityAuthenticated: false as const,
    ...(captured.explicit ? { configuration } : {}), ...(faultInjection ? { faultInjection: { ...faultInjection, finalPhysicalAtMs: physicalAtMs } } : {}), delivery, initialLoad, finalLoad: body.loadSnapshot(), release, parcel, links, linkEvents, runtime })
}

/** A bounded command projection. Matches describe these model cases, never physical delivery. */
export function cargoDeliverySummary(run: CargoDeliveryResult) {
  const configuration = run.configuration ?? fixtureConfiguration, selectedSite = configuration.delivery.site
  const site = { northM: selectedSite.positionM[0], eastM: selectedSite.positionM[1], radiusM: selectedSite.radiusM }
  const rt = run.runtime, power = rt.trace.plan.power, measurements = rt.path.flatMap(row => row.measurement ? [row.measurement] : [])
  const landingContact = rt.mission.state === 'completed' && rt.trace.rows.at(-1)?.observation.onGround === true
  const neutral = rt.board.actuators.length === 4 && rt.board.actuators.every(n => n === 0) && rt.board.expiresAtMs === null
    && (rt.authority.state === 'disarmed' || rt.authority.state === 'killed' || rt.authority.state === 'failsafe' || rt.status === 'host-lost' && rt.board.fault === 'output-lease-expired')
  const separationSeen = run.release?.outcome === 'separated' && run.finalLoad.properties.phase === 'separated' && measurements.some(m => m.values.loadAttached === false && m.values.loadMassKg === 1.5)
  const receiptEvent = run.release?.eventId
  const selectedFault = phaseFault(run.scenario)
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
  else if (selectedFault) {
    const injection = run.faultInjection, fault = selectedFault.fault
    const observedFault = fault === 'hostLost' ? rt.board.fault === 'output-lease-expired' && rt.mission.state === 'running'
      : rt.authority.events.some(event => fault === 'kill' ? event.to === 'killed' : fault === 'rcOverride' ? event.to === 'manual' : fault === 'links' ? event.reason === 'link-loss' : fault === 'dropPosition' ? ['estimator-loss', 'stale-estimator'].includes(event.reason) : event.reason === 'stale-interlocks')
    worldMatched = separationSeen && run.parcel?.onSurface === true && observedFault && !!injection && injection.anchoredAtMs !== null && injection.triggeredAtMs !== null && injection.triggeredAtMs >= injection.anchoredAtMs + 20
      && injection.eventId === receiptEvent && injection.sourceCapturedAtMs !== null && injection.sourceCapturedAtMs >= run.release!.atMs && injection.sourceCapturedAtMs <= injection.anchoredAtMs
      && (selectedFault.phase === 'after-receipt' ? run.delivery.outcome === 'received' && run.delivery.receiptCapturedAtMs !== null : run.delivery.outcome === 'uncertain' && run.delivery.receiptCapturedAtMs === null)
  }
  else if (run.scenario === 'authority-containment') worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.authority.events.some(event => event.reason === 'invalid-target-or-lease') && rt.path.every(row => Math.hypot(row.truthPositionM[0], row.truthPositionM[1]) <= 2)
  else if (run.scenario.startsWith('diversion-')) worldMatched = run.release === null && run.delivery.outcome === 'not-released' && rt.mission.payloadFailure?.reason === 'rejected'
    && rt.authority.events.some(event => event.atMs !== null && event.atMs >= rt.mission.payloadFailure!.triggeredAtMs + 200 && (run.scenario === 'diversion-kill' ? event.to === 'killed' : ['estimator-loss', 'stale-estimator'].includes(event.reason)))
  const expectedStatus = run.scenario === 'nominal' || run.scenario === 'primary-link-loss' ? 'completed' : run.scenario === 'host-loss' || selectedFault?.fault === 'hostLost' ? 'host-lost' : selectedFault || run.scenario === 'both-links-loss' || run.scenario === 'authority-containment' || run.scenario.startsWith('diversion-') || flightFaults.some(value => value === run.scenario) ? 'blocked' : 'diverted'
  const summary = structuredClone({ version: 1, evidence: run.evidence, scenario: run.scenario, status: run.status, demonstrationMatched: worldMatched && run.status === expectedStatus && (!['completed', 'diverted'].includes(expectedStatus) || landingContact) && neutral,
    physicalFlightEnabled: false, boardOutputsInhibited: true, identityAuthenticated: false, ...(run.configuration ? { configuration } : {}), ...(run.faultInjection ? { faultInjection: run.faultInjection } : {}), delivery: run.delivery, landingContact,
    load: { initial: run.initialLoad.properties, final: run.finalLoad.properties },
    release: run.release ? { atMs: run.release.atMs, eventId: run.release.eventId, outcome: run.release.outcome, reason: run.release.reason } : null,
    parcel: run.parcel, links: run.links, linkEvents: run.linkEvents,
    mission: { state: rt.mission.state, taskId: rt.mission.taskId, reason: rt.mission.reason, payloadFailure: rt.mission.payloadFailure ?? null, traceRows: rt.trace.rows.length },
    energy: { evidence: 'declared-mission-power-budget', measured: false, electricalModel: false, capacityWh: power.availableWh, maximumDeclaredW: power.maxW, reservePercent: power.reservePercent,
      worstCaseMs: rt.budget.worstCaseMs, worstCaseRequiredWh: rt.budget.requiredWh, marginAboveReserveWh: power.availableWh * (1 - power.reservePercent / 100) - rt.budget.requiredWh },
    board: { actuators: [...rt.board.actuators], expiresAtMs: rt.board.expiresAtMs, fault: rt.board.fault, physicalActuationEnabled: rt.board.physicalActuationEnabled },
    authority: { hostAvailable: rt.status !== 'host-lost', state: rt.authority.state, reason: rt.authority.reason, lastCheckedAtMs: rt.authority.lastCheckedAtMs, leaseUntilMs: rt.authority.leaseUntilMs },
    model: { loadMassKg: configuration.load.massKg, loadForwardM: configuration.load.forwardM, separation: 'zero-ejection-point-mass', parcel: 'ballistic-point-with-plane-capture', receiver: 'fictional-100ms-receipt', measurementDelayMs: 40, headingAlignment: 'initial-simulation-north' },
  })
  if (new TextEncoder().encode(JSON.stringify(summary)).byteLength + 1 > 16384) throw new RangeError('cargo-delivery-summary-unavailable')
  return summary
}
