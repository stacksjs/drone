import type { SensorVector } from '../sensors/types'
import type { PointLoadAttachment } from '../controls/physics'
import type { VehiclePayloadCommand, VehiclePayloadPort, VehiclePlant, VehicleMissionPlan, VehicleSession } from '../vehicles/types'
import type { ModeledCargoIntakeGrant } from './intake'
import { createRigidBody, createReceivingRigidBody } from '../controls/physics'
import { createMultirotorPlant, createMultirotorProfile } from '../vehicles/multirotor/profile'
import { createRedundantVehicleLinks } from '../vehicles/links'
import type { VehicleLinkScope, VehicleLinkSource } from '../vehicles/links'
import { createVehicleSimulationSession } from '../vehicles/runtime'
import { createCargoStationHandler } from './station'
import { createCargoDeliveryCoordinator } from './coordinator'
import { createCargoIntakeCoordinator } from './intake'
import { planCargoDelivery } from './plan'

type Progress = ReturnType<ReturnType<typeof createVehicleSimulationSession>['step']>
type Station = ReturnType<typeof createCargoStationHandler>
type Release = ReturnType<ReturnType<typeof createReceivingRigidBody>['separateCarriedLoad']>
type Departure = Extract<ReturnType<Station['takeReadyParcel']>, { outcome: 'departed' }>
type Owner = 'source-body' | 'station-actor' | 'receiver-body' | 'final-parcel-actor' | 'loose-parcel'
export const cargoFleetScenarios = ['nominal', 'receiver-host-loss-before-intake', 'intake-receipt-loss', 'receiver-primary-link-loss', 'receiver-both-links-loss', 'receiver-joint-shift-before-intake', 'receiver-navigation-loss-during-rail', 'source-kill-after-station-receipt', 'receiver-kill-after-intake', 'receiver-pad-motion-during-rail', 'receiver-containment-breach-after-intake-receipt'] as const
export type CargoFleetScenario = typeof cargoFleetScenarios[number]
function captureScenario(input: unknown): CargoFleetScenario {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => key !== 'scenario')) throw new TypeError()
    const d = Object.getOwnPropertyDescriptor(input, 'scenario')
    if (d && (!d.enumerable || !Object.hasOwn(d, 'value') || !cargoFleetScenarios.some(name => name === d.value))) throw new TypeError()
    return (d?.value ?? 'nominal') as CargoFleetScenario
  }
  catch { throw new TypeError('cargo-fleet-arguments') }
}
const origin = { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }
const point = { id: 'parcel-a', massKg: .1, forwardM: .08 }
const receiverPadM: SensorVector = [3, 2, -.1]
const stationSite = { id: 'handover-station', recipientId: 'station-operator', containerId: point.id, positionM: [3, 0, 0] as SensorVector, radiusM: .35 }
const finalSite = { id: 'final-site', recipientId: 'final-recipient', containerId: point.id, positionM: [6, 2, 0] as SensorVector, radiusM: .35 }
function receiverMission(): VehicleMissionPlan {
  const spatial = { acceptanceM: .18, maxArrivalSpeedMps: .15, settleMs: 300, timeoutMs: 20000 }
  return { version: 2, vehicle: 'quadcopter', id: 'cargo-fleet-receiver', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin, fence: { radiusM: 12, minDownM: -5, maxDownM: 0 }, rallyM: [3, 2, -1], power: { availableWh: 40, maxW: 600, reservePercent: 30 }, start: 'start', tasks: [
    { id: 'start', kind: 'start', next: 'intake' },
    { id: 'intake', kind: 'payload', operation: 'material-receive', containerId: point.id, positionM: [...receiverPadM], timeoutMs: 60000, next: 'depart', onFailure: 'alternate-approach' },
    { id: 'depart', kind: 'takeoff', positionM: [3, 2, -1], ...spatial, next: 'site' },
    { id: 'site', kind: 'waypoint', positionM: [6, 2, -1], ...spatial, settleMs: 800, next: 'release' },
    { id: 'release', kind: 'payload', operation: 'material-drop', containerId: point.id, timeoutMs: 1500, next: 'home', onFailure: 'alternate-approach' },
    { id: 'home', kind: 'return', ...spatial, next: 'land' },
    { id: 'land', kind: 'land', positionM: [3, 2, 0], ...spatial },
    { id: 'alternate-approach', kind: 'waypoint', positionM: [5, 3, -1], ...spatial, next: 'alternate-land' },
    { id: 'alternate-land', kind: 'land', positionM: [5, 3, 0], ...spatial },
  ] }
}
function hasAuthority(p: Progress | null, command: VehiclePayloadCommand, nowMs: number, bootId: bigint, sessionId: bigint) {
  return !!p && p.atMs === nowMs && p.hostAvailable && !p.terminal && p.phase === 'host' && p.policyAtMs !== null && p.policyAtMs <= nowMs && nowMs - p.policyAtMs < 20
    && p.reference === command.reference && p.authority.bootId === bootId && p.authority.sessionId === sessionId && p.authority.state === 'autonomous'
    && p.authority.lastCheckedAtMs !== null && nowMs - p.authority.lastCheckedAtMs < 20 && p.authority.leaseUntilMs !== null && p.authority.leaseUntilMs > nowMs && p.board.fault === null
    && p.mission.state === 'running' && p.mission.payload?.eventId === command.eventId && JSON.stringify(p.mission.payload) === JSON.stringify(command) && command.expiresAtMs > nowMs
}

/** One modeled parcel, two retained raw-sensor/estimator/authority runtimes, and finite station physics. */
export function simulateCargoFleet(input: unknown = {}, ...extra: unknown[]) {
  if (extra.length) throw new TypeError('cargo-fleet-arguments')
  const scenario = captureScenario(input)
  const faultInjection: { scenario: Exclude<CargoFleetScenario, 'nominal'>, anchoredAtMs: number | null, triggeredAtMs: number | null, forceN?: SensorVector, forceRampMs?: number } | null = scenario === 'nominal' ? null : { scenario, anchoredAtMs: null, triggeredAtMs: null, ...(['receiver-pad-motion-during-rail', 'receiver-containment-breach-after-intake-receipt'].includes(scenario) ? { forceN: [scenario === 'receiver-pad-motion-during-rail' ? 4 : 8, 0, 0] as SensorVector, ...(scenario === 'receiver-containment-breach-after-intake-receipt' ? { forceRampMs: 2000 } : {}) } : {}) }
  const bodyA = createRigidBody({ positionM: [0, 0, -.1], groundDownM: -.1, carriedPointLoad: point })
  const bodyB = createReceivingRigidBody({ positionM: [...receiverPadM], groundDownM: -.1, expectedPointLoad: point })
  const initialA = bodyA.loadSnapshot(), initialB = bodyB.loadSnapshot()
  let station: Station | null = null, recipient: Station | null = null, loose: Station | null = null
  const physical: { owner: Owner } = { owner: 'source-body' }
  let maximumMassErrorKg = 0, massSamples = 0
  const transitions: { atMs: number, from: Owner, to: Owner }[] = []
  let sourceRelease: { atMs: number, eventId: string, event: Release } | null = null, finalRelease: { atMs: number, eventId: string, event: Release } | null = null
  let stationDeparture: Departure | null = null
  let intake: { atMs: number, grant: ModeledCargoIntakeGrant, attachment: PointLoadAttachment, source: Progress, receiver: Progress } | null = null
  let intakeEvidence: { atMs: number, eventId: string, sourceEventId: string, outcome: string, massKg: number } | null = null
  const commands: { source: VehiclePayloadCommand | null, receiver: VehiclePayloadCommand | null, intake: ModeledCargoIntakeGrant | null } = { source: null, receiver: null, intake: null }
  let progressA: Progress | null = null, progressB: Progress | null = null
  const sourceCoordinator = createCargoDeliveryCoordinator({ origin, site: stationSite, releaseHeightM: 1 }, {
    evidence: 'modeled-cargo-mechanism', request(command) { commands.source = structuredClone(command) }, cancel(eventId) { if (commands.source?.eventId === eventId) commands.source = null },
  })
  const deliveryCoordinator = createCargoDeliveryCoordinator({ origin, site: finalSite, releaseHeightM: 1 }, {
    evidence: 'modeled-cargo-mechanism', request(command) { commands.receiver = structuredClone(command) }, cancel(eventId) { if (commands.receiver?.eventId === eventId) commands.receiver = null },
  })
  const intakeCoordinator = createCargoIntakeCoordinator({ origin, padM: receiverPadM, receiverId: 'carrier-b', containerId: point.id, massKg: point.massKg, bootId: 102n, sessionId: 202n }, {
    evidence: 'modeled-cargo-intake-mechanism', request(grant) { commands.intake = structuredClone(grant); if (faultInjection && ['receiver-host-loss-before-intake', 'receiver-joint-shift-before-intake'].includes(faultInjection.scenario)) faultInjection.anchoredAtMs = grant.issuedAtMs }, cancel(eventId) { if (commands.intake?.command.eventId === eventId) commands.intake = null },
  })
  let activeBPort: VehiclePayloadPort | null = null
  const receiverPort: VehiclePayloadPort = {
    observe(c) { intakeCoordinator.port.observe!(c); deliveryCoordinator.port.observe!(c) },
    request(command) { activeBPort = command.operation === 'material-receive' ? intakeCoordinator.port : deliveryCoordinator.port; activeBPort.request(command) },
    poll(nowMs) { const ack = activeBPort?.poll(nowMs) ?? null; if (ack) activeBPort = null; return ack },
    close() { activeBPort = null; intakeCoordinator.port.close(); deliveryCoordinator.port.close() },
  }
  function linksFor(scope: VehicleLinkScope, receiver: boolean) {
    const monitor = createRedundantVehicleLinks(scope), queue: { sourceId: VehicleLinkSource, sequence: number, capturedAtMs: number, receivedAtMs: number }[] = []
    let sequence = 0, last = monitor.snapshot(0)
    const events: typeof last[] = []
    return {
      observe(nowMs: number) {
        sequence++
        if (receiver && faultInjection && ['receiver-primary-link-loss', 'receiver-both-links-loss'].includes(faultInjection.scenario) && faultInjection.anchoredAtMs === null && station?.snapshot().phase === 'held') faultInjection.anchoredAtMs = nowMs
        for (const sourceId of ['primary', 'backup'] as const) {
          if (receiver && faultInjection && ['receiver-primary-link-loss', 'receiver-both-links-loss'].includes(faultInjection.scenario) && (sourceId === 'primary' || faultInjection.scenario === 'receiver-both-links-loss') && faultInjection.anchoredAtMs !== null && nowMs >= faultInjection.anchoredAtMs) { faultInjection.triggeredAtMs ??= nowMs; continue }
          if (queue.length >= 8) throw new RangeError('cargo-fleet-link-queue')
          queue.push({ sourceId, sequence, capturedAtMs: nowMs, receivedAtMs: nowMs + (sourceId === 'primary' ? 20 : 40) })
        }
        queue.sort((a, b) => a.receivedAtMs - b.receivedAtMs)
        while (queue[0] && queue[0].receivedAtMs <= nowMs) monitor.ingest({ ...scope, ...queue.shift()!, clockUncertaintyMs: 1, connected: true }, nowMs)
        last = monitor.snapshot(nowMs)
        const previous = events.at(-1)
        if (!previous || last.selectedSource !== previous.selectedSource || last.latchedLoss !== previous.latchedLoss) { if (events.length >= 16) throw new RangeError('cargo-fleet-link-events'); events.push(structuredClone(last)) }
        return { ...last.authority }
      },
      snapshot: () => structuredClone(last), events: () => structuredClone(events),
    }
  }
  const linksA = linksFor({ vehicleId: 'carrier-a', bootId: 101, sessionId: 201 }, false), linksB = linksFor({ vehicleId: 'carrier-b', bootId: 102, sessionId: 202 }, true)
  const profileA = createMultirotorProfile(), profileB = createMultirotorProfile(), createA = profileA.createSession, createB = profileB.createSession
  profileA.mission = planCargoDelivery({ version: 1, id: 'cargo-fleet-source', delivery: { origin, site: stationSite, releaseHeightM: 1 }, load: { massKg: point.massKg, forwardM: point.forwardM }, alternateM: [1.5, -2, 0], power: { availableWh: 40, maxW: 600, reservePercent: 30 } }).mission
  profileB.mission = receiverMission()
  if (scenario === 'receiver-containment-breach-after-intake-receipt') profileB.positionPrediction = 'fixture-imu'
  const baseFaultsA = profileA.faults
  if (scenario === 'source-kill-after-station-receipt') {
    profileA.scenario = scenario; profileA.scenarios = [scenario]
    profileA.faults = (selected, atMs, phase) => {
      if (selected !== scenario) throw new TypeError('cargo-fleet-scenario-changed')
      const killed = faultInjection!.anchoredAtMs !== null && atMs > faultInjection!.anchoredAtMs
      if (killed && phase === 'host') faultInjection!.triggeredAtMs ??= atMs
      return { ...baseFaultsA('nominal', atMs, phase), kill: killed }
    }
  }
  const baseFaultsB = profileB.faults
  profileB.scenario = scenario; profileB.scenarios = [scenario]
  profileB.faults = (selected, atMs, phase) => {
    if (selected !== scenario) throw new TypeError('cargo-fleet-scenario-changed')
    const active = faultInjection?.scenario === 'receiver-host-loss-before-intake' && faultInjection.anchoredAtMs !== null && atMs >= faultInjection.anchoredAtMs + 4
    if (active && phase === 'host') faultInjection!.triggeredAtMs ??= atMs
    const navigationLost = faultInjection?.scenario === 'receiver-navigation-loss-during-rail' && faultInjection.anchoredAtMs !== null && atMs > faultInjection.anchoredAtMs
    if (navigationLost && phase === 'host') faultInjection!.triggeredAtMs ??= atMs
    const killed = faultInjection?.scenario === 'receiver-kill-after-intake' && faultInjection.anchoredAtMs !== null && atMs > faultInjection.anchoredAtMs
    if (killed && phase === 'host') faultInjection!.triggeredAtMs ??= atMs
    return { ...baseFaultsB('nominal', atMs, phase), hostLost: active, dropPosition: navigationLost, kill: killed }
  }
  const plantA = createMultirotorPlant(bodyA), adaptedB = createMultirotorPlant(bodyB)
  let receiverPhysicalAtMs = 600
  const plantB: VehiclePlant = { snapshot: adaptedB.snapshot, step(actuators, dtS, environment) {
    if (dtS !== .004) throw new RangeError('cargo-fleet-receiver-step')
    receiverPhysicalAtMs += 4
    const shift = faultInjection?.scenario === 'receiver-joint-shift-before-intake' && faultInjection.anchoredAtMs !== null && receiverPhysicalAtMs === faultInjection.anchoredAtMs + 4
    if (shift) faultInjection!.triggeredAtMs = receiverPhysicalAtMs
    const containment = faultInjection && ['receiver-pad-motion-during-rail', 'receiver-containment-breach-after-intake-receipt'].includes(faultInjection.scenario) && faultInjection.anchoredAtMs !== null && receiverPhysicalAtMs > faultInjection.anchoredAtMs
    if (containment) faultInjection!.triggeredAtMs ??= receiverPhysicalAtMs
    bodyB.step(actuators as [number, number, number, number], dtS, { windMps: environment.windMps, ...(shift || containment ? { forceN: shift ? [.4, 0, 0] as SensorVector : faultInjection!.forceN!.map(n => n * Math.min(1, (receiverPhysicalAtMs - faultInjection!.anchoredAtMs!) / (faultInjection!.forceRampMs ?? 4))) as SensorVector } : {}) })
    return adaptedB.snapshot()
  } }
  function releaseValues(which: 'source' | 'receiver') {
    const released = which === 'source' ? sourceRelease : finalRelease, target = which === 'source' ? station : recipient, site = which === 'source' ? stationSite : finalSite
    const impact = target?.snapshot().impact
    const captured = !!impact && impact.positionM[2] === site.positionM[2] && Math.hypot(impact.positionM[0] - site.positionM[0], impact.positionM[1] - site.positionM[1]) <= site.radiusM
    return { siteId: site.id, recipientId: site.recipientId, siteClear: true, recipientPresent: true, loadAttached: which === 'source' ? bodyA.loadSnapshot().properties.phase === 'attached' : bodyB.loadSnapshot().properties.phase === 'attached', mechanismOpen: released?.event.outcome === 'separated', mechanismJammed: false, mechanismEventId: released?.eventId ?? '', receiptEventId: captured ? released?.eventId ?? '' : '', receiptContainerId: point.id }
  }
  profileA.createSession = (): VehicleSession => {
    const base = createA()
    return { ...base, linkObservation: linksA.observe, createPlant: () => plantA, createPayload: () => sourceCoordinator.port, renderMeasurement(state, atMs, reference) { const packet = base.renderMeasurement(state, atMs, reference); return { ...packet, values: { ...packet.values, ...releaseValues('source') } } } }
  }
  profileB.createSession = (): VehicleSession => {
    const base = createB()
    return { ...base, linkObservation: linksB.observe, createPlant: () => plantB, createPayload: () => receiverPort, renderMeasurement(state, atMs, reference) {
      const packet = base.renderMeasurement(state, atMs, reference)
      const suppressReceipt = faultInjection?.scenario === 'intake-receipt-loss' && intakeEvidence !== null
      if (suppressReceipt) faultInjection!.triggeredAtMs ??= atMs
      const evidence = suppressReceipt ? null : intakeEvidence
      return { ...packet, values: { ...packet.values, ...releaseValues('receiver'), receiverId: 'carrier-b', stationReady: station?.snapshot().phase === 'ready', stationContainerId: point.id, stationSourceEventId: sourceRelease?.eventId ?? '',
        intakeAtMs: evidence?.atMs ?? -1, intakeEventId: evidence?.eventId ?? '', intakeSourceEventId: evidence?.sourceEventId ?? '', intakeOutcome: evidence?.outcome ?? '', intakeMassKg: evidence?.massKg ?? 0 } }
    } }
  }
  const a = createVehicleSimulationSession(profileA, { seconds: 180, neutralTailMs: 1000, scope: { bootId: 101n, sessionId: 201n } })
  const b = createVehicleSimulationSession(profileB, { seconds: 180, neutralTailMs: 1000, scope: { bootId: 102n, sessionId: 202n } })
  function changeOwner(next: Owner, nowMs: number) { transitions.push({ atMs: nowMs, from: physical.owner, to: next }); physical.owner = next }
  function totalMass() { return bodyA.loadSnapshot().properties.totalMassKg + bodyB.loadSnapshot().properties.totalMassKg + (station?.snapshot().ownedMassKg ?? 0) + (recipient?.snapshot().ownedMassKg ?? 0) + (loose?.snapshot().ownedMassKg ?? 0) }
  function sampleMass() { maximumMassErrorKg = Math.max(maximumMassErrorKg, Math.abs(totalMass() - 3.1)); massSamples++ }
  sampleMass()
  try {
    for (let nowMs = 0; nowMs <= 181000; nowMs += 4) {
      if (!progressA?.terminal) progressA = a.step(nowMs)
      if (!progressB?.terminal) progressB = b.step(nowMs)
      if (faultInjection?.scenario === 'source-kill-after-station-receipt' && faultInjection.anchoredAtMs === null) {
        const receipt = sourceCoordinator.snapshot().delivery
        if (receipt.outcome === 'received') faultInjection.anchoredAtMs = receipt.acknowledgedAtMs
      }
      if (faultInjection?.scenario === 'receiver-containment-breach-after-intake-receipt' && faultInjection.anchoredAtMs === null) {
        const receipt = intakeCoordinator.snapshot().custody
        if (receipt.outcome === 'received') faultInjection.anchoredAtMs = receipt.acknowledgedAtMs
      }
      if (station && station.snapshot().atMs < nowMs) station.step(nowMs)
      if (recipient && recipient.snapshot().atMs < nowMs) recipient.step(nowMs)
      if (loose && loose.snapshot().atMs < nowMs) loose.step(nowMs)
      if (commands.source && nowMs > commands.source.issuedAtMs) {
        const command = commands.source; commands.source = null
        if (physical.owner === 'source-body' && hasAuthority(progressA, command, nowMs, 101n, 201n)) {
          const event = bodyA.separateCarriedLoad(); sourceRelease = { atMs: nowMs, eventId: command.eventId, event }
          if (event.outcome === 'separated') {
            station = createCargoStationHandler({ atMs: nowMs, parcel: { id: point.id, ...event.parcel }, pickup: { centerM: stationSite.positionM, radiusM: stationSite.radiusM }, destinationM: bodyB.intakePoint().positionM, maxSpeedMps: .5, maxAccelerationMps2: 1 })
            changeOwner('station-actor', nowMs); sampleMass()
          }
        }
      }
      if (station?.snapshot().phase === 'held' && sourceCoordinator.snapshot().delivery.outcome === 'received' && progressB?.mission.payload?.operation === 'material-receive' && hasAuthority(progressB, progressB.mission.payload, nowMs, 102n, 202n)) {
        station.start()
        if (faultInjection && ['receiver-navigation-loss-during-rail', 'receiver-pad-motion-during-rail'].includes(faultInjection.scenario)) faultInjection.anchoredAtMs ??= nowMs
      }
      if (station && ['falling', 'held', 'moving', 'ready'].includes(station.snapshot().phase) && progressB && (!progressB.hostAvailable || progressB.authority.state !== 'autonomous')) station.cancel()
      if (commands.intake && nowMs > commands.intake.issuedAtMs) {
        const grant = commands.intake; commands.intake = null
        if (physical.owner === 'station-actor' && station?.snapshot().phase === 'ready' && sourceRelease?.eventId === grant.sourceEventId && grant.receiverId === 'carrier-b' && grant.bootId === 102n && grant.sessionId === 202n && nowMs < grant.expiresAtMs
          && hasAuthority(progressB, grant.command, nowMs, grant.bootId, grant.sessionId) && progressB!.board.actuators.every(n => n === 0) && bodyB.snapshot().motorsN.every(n => n < .01)) {
          const departure = station.takeReadyParcel()
          if (departure.outcome === 'departed') {
            stationDeparture = departure
            const attachment = bodyB.attachParcel(departure.parcel)
            intake = { atMs: nowMs, grant, attachment, source: structuredClone(progressA!), receiver: structuredClone(progressB!) }
            intakeEvidence = { atMs: nowMs, eventId: grant.command.eventId, sourceEventId: grant.sourceEventId, outcome: attachment.outcome, massKg: attachment.outcome === 'attached' ? attachment.parcel.massKg : 0 }
            if (attachment.outcome === 'attached') { loose = null; changeOwner('receiver-body', nowMs); if (faultInjection && ['intake-receipt-loss', 'receiver-kill-after-intake'].includes(faultInjection.scenario)) faultInjection.anchoredAtMs = nowMs }
            else { loose = createCargoStationHandler({ atMs: nowMs, parcel: departure.parcel, pickup: { centerM: [3, 2, 0], radiusM: 2 }, destinationM: [3, 2, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 }); changeOwner('loose-parcel', nowMs) }
            sampleMass()
          }
        }
      }
      if (commands.receiver && nowMs > commands.receiver.issuedAtMs) {
        const command = commands.receiver; commands.receiver = null
        if (physical.owner === 'receiver-body' && hasAuthority(progressB, command, nowMs, 102n, 202n)) {
          const event = bodyB.separateCarriedLoad(); finalRelease = { atMs: nowMs, eventId: command.eventId, event }
          if (event.outcome === 'separated') {
            recipient = createCargoStationHandler({ atMs: nowMs, parcel: { id: point.id, ...event.parcel }, pickup: { centerM: finalSite.positionM, radiusM: finalSite.radiusM }, destinationM: finalSite.positionM, maxSpeedMps: .5, maxAccelerationMps2: 1 })
            changeOwner('final-parcel-actor', nowMs); sampleMass()
          }
        }
      }
      if (nowMs % 20 === 0) sampleMass()
      if (progressA?.terminal && progressB?.terminal) break
    }
    const sourceRun = a.result(), receiverRun = b.result(), sourceDelivery = sourceCoordinator.snapshot().delivery, receiverDelivery = deliveryCoordinator.snapshot().delivery, receiverIntake = intakeCoordinator.snapshot()
    const completed = sourceRun.status === 'completed' && receiverRun.status === 'completed' && sourceDelivery.outcome === 'received' && receiverIntake.custody.outcome === 'received' && receiverDelivery.outcome === 'received' && physical.owner === 'final-parcel-actor' && recipient?.snapshot().phase === 'held' && maximumMassErrorKg < 1e-12
    return { version: 1, evidence: 'owned-cargo-fleet-simulation' as const, scenario, faultInjection, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, identityAuthenticated: false as const, status: completed ? 'completed' as const : 'unqualified' as const,
      source: { links: linksA.snapshot(), linkEvents: linksA.events(), initialLoad: initialA, finalLoad: bodyA.loadSnapshot(), runtime: sourceRun, delivery: sourceDelivery }, receiver: { links: linksB.snapshot(), linkEvents: linksB.events(), initialLoad: initialB, finalLoad: bodyB.loadSnapshot(), runtime: receiverRun, intake: receiverIntake, delivery: receiverDelivery },
      transfer: { sourceRelease, stationDeparture, intake, finalRelease }, station: station?.snapshot() ?? null, recipient: recipient?.snapshot() ?? null, loose: loose?.snapshot() ?? null, ownership: { owner: physical.owner, initialMassKg: 3.1, finalMassKg: totalMass(), maximumMassErrorKg, samples: massSamples, transitions } }
  }
  finally { a.close(); b.close() }
}

/** Compact actual observations for Buddy/standalone output; never serialize the full runtime journal. */
export function cargoFleetSummary(run: ReturnType<typeof simulateCargoFleet>) {
  function vehicle(runtime: typeof run.source.runtime) {
    const power = runtime.trace.plan.power, usableWh = power.availableWh * (1 - power.reservePercent / 100)
    return { scope: { bootId: String(runtime.board.bootId), sessionId: String(runtime.authority.sessionId) }, status: runtime.status, fault: runtime.fault, missionState: runtime.mission.state, missionReason: runtime.mission.reason, payloadFailure: runtime.mission.payloadFailure ?? null,
      finalPositionM: runtime.finalTruthPositionM, sensors: runtime.navigationEvidence.observedSensors, board: { physicalActuationEnabled: runtime.board.physicalActuationEnabled, actuators: runtime.board.actuators, fault: runtime.board.fault, expiresAtMs: runtime.board.expiresAtMs },
      energy: { evidence: 'declared-mission-power-budget', measured: false, electricalModel: false, availableWh: power.availableWh, maxW: power.maxW, reservePercent: power.reservePercent, worstCaseMs: runtime.budget.worstCaseMs, requiredWh: runtime.budget.requiredWh, marginAboveReserveWh: usableWh - runtime.budget.requiredWh } }
  }
  const capturedIntake = run.transfer.intake, attachment = capturedIntake?.attachment
  const release = (event: typeof run.transfer.sourceRelease) => event ? { atMs: event.atMs, eventId: event.eventId, outcome: event.event.outcome } : null
  return { version: run.version, evidence: run.evidence, scenario: run.scenario, status: run.status, physicalFlightEnabled: run.physicalFlightEnabled, boardOutputsInhibited: run.boardOutputsInhibited, identityAuthenticated: run.identityAuthenticated,
    faultInjection: run.faultInjection, source: { links: run.source.links, linkEvents: run.source.linkEvents, ...vehicle(run.source.runtime), initialLoad: run.source.initialLoad.properties, finalLoad: run.source.finalLoad.properties, delivery: run.source.delivery },
    receiver: { links: run.receiver.links, linkEvents: run.receiver.linkEvents, ...vehicle(run.receiver.runtime), initialLoad: run.receiver.initialLoad.properties, finalLoad: run.receiver.finalLoad.properties, intake: run.receiver.intake.custody, delivery: run.receiver.delivery },
    transfer: { sourceRelease: release(run.transfer.sourceRelease), stationDeparture: run.transfer.stationDeparture, intake: capturedIntake ? { atMs: capturedIntake.atMs, outcome: attachment!.outcome, eventId: capturedIntake.grant.command.eventId, sourceEventId: capturedIntake.grant.sourceEventId,
      receiverScope: { bootId: String(capturedIntake.receiver.authority.bootId), sessionId: String(capturedIntake.receiver.authority.sessionId), epoch: capturedIntake.receiver.authority.epoch, reference: capturedIntake.receiver.reference, policyAtMs: capturedIntake.receiver.policyAtMs },
      massBeforeKg: attachment!.outcome === 'attached' ? attachment!.before.properties.totalMassKg : null, massAfterKg: attachment!.outcome === 'attached' ? attachment!.after.properties.totalMassKg : null } : null, finalRelease: release(run.transfer.finalRelease) },
    station: run.station, recipient: run.recipient, loose: run.loose, ownership: run.ownership }
}
