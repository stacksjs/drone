import type { SensorVector } from '../sensors/types'
import type { VehicleBatteryObservation, VehiclePayloadAck, VehiclePayloadCommand, VehicleProfile, VehicleVtolTransitionCommand, VehicleVtolTransitionObservation } from './types'
import { exampleMission, missionEdges, missionTaskTarget, validateMission } from '../missions/plan'
import { missionScenarios, simulateMission } from '../missions/simulation'
import type { MissionScenario } from '../missions/simulation'
import { validateVehicleMission, vehicleTaskTarget } from '../missions/vehicle'
import { airScenarios, createAirProfile } from './air'
import { createGroundProfile, groundScenarios } from './ground'
import { createSurfaceProfile, surfaceScenarios } from './surface'
import type { SurfaceScenario } from './surface'
import { reduceSurfaceSurvey } from './surface/survey'
import { createSubseaProfile, subseaScenarios } from './subsea'
import type { SubseaScenario } from './subsea'
import { reduceSubseaInspection } from './subsea/inspection'
import { runVehicleSimulation } from './runtime'
import { observeVehicleBattery } from './measurements'
import { createVtolSimulationCase, vtolSimulationPhases, vtolSimulationScenarios } from './vtol/simulation'
export const missionWorkspaceProfiles = ['quadcopter', 'fixed-wing', 'vtol', 'ground', 'surface', 'subsea'] as const
export type MissionWorkspaceProfile = typeof missionWorkspaceProfiles[number]
export interface WorkspaceTask { id: string, kind: string, targetM: SensorVector | null, edges: string[], operation: string | null, containerId: string | null, failureEdge?: string | null, mode?: string | null }
export interface WorkspacePayload { eventId: string, taskId: string, operation: string, containerId: string | null, evidence: 'simulated-event' | 'modeled-request', issuedAtMs: number, expiresAtMs: number | null, reference: string | null }
export interface WorkspaceAck extends VehiclePayloadAck { correlated: boolean }
export interface WorkspaceRow { atMs: number, state: string, taskId: string, reason: string, positionM: SensorVector, velocityMps: SensorVector, targetM: SensorVector | null, payloadRequest: WorkspacePayload | null, payloadAck: WorkspaceAck | null, vtol?: { action: string | null, request: VehicleVtolTransitionCommand | null, observation: VehicleVtolTransitionObservation | null, battery: VehicleBatteryObservation | null } }
export interface MissionWorkspaceOptions { phase?: string, electrical?: boolean }
const vector = (input: number[] | null): SensorVector | null => input ? [...input] as SensorVector : null
const vehicleProfiles = {
  'fixed-wing': { create: createAirProfile, scenarios: airScenarios, assumptions: 'Fictional trainer, level runway and modeled aerodynamic coefficients. VTOL and physical airworthiness remain unqualified.' },
  ground: { create: createGroundProfile, scenarios: groundScenarios, assumptions: 'Modeled tire traction, people/range coverage and guarded implements. No physical mowing or materials handling.' },
  surface: { create: (scenario: string) => createSurfaceProfile(scenario as SurfaceScenario), scenarios: surfaceScenarios, assumptions: 'Level water model, single vertical beam and modeled sampling bottle. No certified bathymetry or physical sampling.' },
  subsea: { create: (scenario: string) => createSubseaProfile(scenario as SubseaScenario), scenarios: subseaScenarios, assumptions: 'Pressure depth and bottom-locked DVL dead reckoning from a declared surface alignment. Relative yaw assumes initial north. GPS is absent underwater. Camera and sonar records are modeled fixtures.' },
} satisfies Record<Exclude<MissionWorkspaceProfile, 'quadcopter' | 'vtol'>, { create: (scenario: string) => VehicleProfile, scenarios: readonly string[], assumptions: string }>
function selected(profile: MissionWorkspaceProfile, scenario: string) {
  if (!missionWorkspaceProfiles.includes(profile)) throw new RangeError('Unknown mission workspace profile')
  const scenarios: readonly string[] = profile === 'quadcopter' ? missionScenarios : profile === 'vtol' ? vtolSimulationScenarios : vehicleProfiles[profile].scenarios
  if (!scenarios.includes(scenario)) throw new RangeError('Unknown mission workspace scenario')
  return scenarios
}
function vehicleProfile(profile: Exclude<MissionWorkspaceProfile, 'quadcopter' | 'vtol'>, scenario: string) { return vehicleProfiles[profile].create(scenario) }
export function getMissionWorkspaceDefinition(profile: MissionWorkspaceProfile = 'quadcopter', scenario = 'nominal', options: MissionWorkspaceOptions = {}) {
  const scenarios = selected(profile, scenario)
  if (profile !== 'vtol' && (options.phase !== undefined || options.electrical !== undefined)) throw new RangeError('VTOL options require the VTOL workspace profile')
  if (profile === 'quadcopter') {
    const plan = exampleMission(), budget = validateMission(plan)
    return { profile, scenario, version: 1, name: 'Owned quadcopter', planId: plan.id, scenarios: [...scenarios], frame: plan.frame, origin: { ...plan.origin }, fence: { ...plan.fence, maxDownM: 0 }, rallyM: [...plan.rallyM], budget: { worstCaseMs: budget.worstCaseMs, requiredWh: budget.requiredWh, usableWh: plan.power.availableWh * (1 - plan.power.reservePercent / 100) }, tasks: plan.tasks.map((t): WorkspaceTask => ({ id: t.id, kind: t.kind, targetM: missionTaskTarget(plan, t), edges: missionEdges(t), operation: t.kind === 'payload' ? t.channel : null, containerId: null } satisfies WorkspaceTask)), assumptions: 'Flat origin plane and modeled quad landing gear. Camera events do not acquire images.' }
  }
  const vtolCase = profile === 'vtol' ? createVtolSimulationCase(scenario, options) : null
  const p = vtolCase ? vtolCase.profile : vehicleProfile(profile as Exclude<MissionWorkspaceProfile, 'quadcopter' | 'vtol'>, scenario), { plan, worstCaseMs, requiredWh } = validateVehicleMission(p.mission)
  return { profile, scenario, version: 2, name: p.name, planId: plan.id, scenarios: [...scenarios], frame: plan.frame, origin: { ...plan.origin }, fence: { ...plan.fence }, rallyM: [...plan.rallyM], budget: { worstCaseMs, requiredWh, usableWh: plan.power.availableWh * (1 - plan.power.reservePercent / 100) }, tasks: plan.tasks.map((t): WorkspaceTask => ({ id: t.id, kind: t.kind, targetM: vector(vehicleTaskTarget(plan, t)), edges: t.kind === 'branch' ? [t.then, t.otherwise] : 'next' in t && t.next ? [t.next] : [], operation: t.kind === 'payload' ? t.operation : null, containerId: t.kind === 'payload' ? t.containerId : null, ...(profile === 'vtol' ? { failureEdge: t.kind === 'vtol-mode' ? t.onFailure ?? null : null, mode: t.kind === 'vtol-mode' ? t.mode : null } : {}) } satisfies WorkspaceTask)), assumptions: vtolCase ? 'Fictional lift-and-cruise model. Captured mode observations and optional battery readings are modeled evidence. No physical transition or recovery qualification.' : vehicleProfiles[profile as Exclude<MissionWorkspaceProfile, 'quadcopter' | 'vtol'>].assumptions,
    ...(vtolCase ? { vtol: { phase: vtolCase.phase, phases: vtolCase.phase ? [...vtolSimulationPhases] : [], electrical: vtolCase.electrical, seconds: vtolCase.seconds } } : {}) }
}
function request(payload: VehiclePayloadCommand): WorkspacePayload { return { eventId: payload.eventId, taskId: payload.taskId, operation: payload.operation, containerId: payload.containerId, issuedAtMs: payload.issuedAtMs, expiresAtMs: payload.expiresAtMs, reference: payload.reference, evidence: 'modeled-request' } }
function ackFor(ack: VehiclePayloadAck, seen: Map<string, WorkspacePayload>): WorkspaceAck {
  const pending = seen.get(ack.eventId)
  const correlated = !!pending && ack.taskId === pending.taskId && ack.operation === pending.operation && ack.containerId === pending.containerId && ack.reference === pending.reference && ack.capturedAtMs >= pending.issuedAtMs && ack.capturedAtMs < pending.expiresAtMs!
  return { ...structuredClone(ack), correlated }
}
/** Presentation adapter only. It does not provide policy inputs, authority or physical endpoints. */
export function runMissionWorkspace(profile: MissionWorkspaceProfile = 'quadcopter', scenario = 'nominal', options: MissionWorkspaceOptions = {}) {
  const definition = getMissionWorkspaceDefinition(profile, scenario, options), requests = new Map<string, WorkspacePayload>()
  if (profile === 'quadcopter') {
    const r = simulateMission({ scenario: scenario as MissionScenario, seconds: 120 })
    const rows: WorkspaceRow[] = r.trace.rows.map(row => {
      const payloadRequest: WorkspacePayload | null = row.result.payload ? { eventId: `v1:${row.result.payload.taskId}`, taskId: row.result.payload.taskId, operation: row.result.payload.channel, containerId: null, issuedAtMs: row.observation.nowMs, expiresAtMs: null, reference: row.observation.reference, evidence: 'simulated-event' } : null
      if (payloadRequest && !requests.has(payloadRequest.eventId)) requests.set(payloadRequest.eventId, payloadRequest)
      return { atMs: row.observation.nowMs, state: row.result.state, taskId: row.result.taskId, reason: row.result.reason, positionM: [...row.observation.positionM], velocityMps: [...row.observation.velocityMps], targetM: vector(row.result.targetM), payloadRequest, payloadAck: null }
    })
    return { definition, status: r.mission.state === 'completed' ? 'completed' : r.mission.state === 'running' || r.mission.state === 'paused' ? 'duration-exhausted' : 'blocked', fault: r.mission.state === 'completed' ? null : r.mission.reason, rows, transitions: structuredClone(r.transitions), payloads: [...requests.values()], authorityState: r.authority.state, snapshotsStale: false, boardNeutral: r.board.motorsN.every(n => n === 0), boardFault: r.board.fault, physicalActuationEnabled: false as const, survey: null, inspection: null, navigationEvidence: null, minimumTimeMs: rows[0]?.atMs ?? 600, maximumTimeMs: rows.at(-1)?.atMs ?? 600 }
  }
  const vtolCase = profile === 'vtol' ? createVtolSimulationCase(scenario, options) : null
  const vtolRun = vtolCase?.run()
  const p = vtolCase ? vtolCase.profile : vehicleProfile(profile as Exclude<MissionWorkspaceProfile, 'quadcopter' | 'vtol'>, scenario), r = vtolRun ? vtolRun.result : runVehicleSimulation(p, { scenario, seconds: 180 })
  const rows: WorkspaceRow[] = r.trace.rows.map((row, index) => {
    const payloadRequest = row.result.payload ? request(row.result.payload) : null
    if (payloadRequest) requests.set(payloadRequest.eventId, payloadRequest)
    const captured = r.path[index]
    return { atMs: row.observation.nowMs, state: row.result.state, taskId: row.result.taskId, reason: row.result.reason, positionM: [...row.observation.positionM], velocityMps: [...row.observation.velocityMps], targetM: vector(row.result.targetM), payloadRequest, payloadAck: row.observation.payloadAck ? ackFor(row.observation.payloadAck, requests) : null,
      ...(vtolCase ? { vtol: { action: row.action ?? null, request: row.result.transition ? structuredClone(row.result.transition) : null, observation: row.observation.transition ? structuredClone(row.observation.transition) : null, battery: p.batteryModel && captured?.atMs === row.observation.nowMs && captured.measurement ? observeVehicleBattery(captured.measurement, p.batteryModel, row.observation.nowMs) : null } } : {}) }
  })
  let survey: { count: number, minimumDepthM: number, maximumDepthM: number, maximumVerticalSigmaM: number, maximumHorizontalSigmaM: number, datum: string, assumptions: string } | null = null
  if (profile === 'surface' && r.path.some(row => row.measurement && row.measurementPose)) {
    const reduced = reduceSurfaceSurvey(r.path, { positionSigmaM: 1, timeSigmaMs: 2, attitudeSigmaRad: 0.002 })
    survey = { count: reduced.soundings.length, minimumDepthM: Math.min(...reduced.soundings.map(s => s.depthBelowDatumM)), maximumDepthM: Math.max(...reduced.soundings.map(s => s.depthBelowDatumM)), maximumVerticalSigmaM: Math.max(...reduced.soundings.map(s => s.verticalSigmaM)), maximumHorizontalSigmaM: Math.max(...reduced.soundings.map(s => s.horizontalSigmaM)), datum: reduced.metadata.verticalDatum, assumptions: 'Modeled single beam only. User-declared model sigmas: horizontal position 1 m, clock 2 ms, attitude 0.002 rad. One standard deviation, independent terms; no charting certification.' }
  }
  const inspection = profile === 'subsea' && rows.some(row => row.payloadAck?.operation === 'inspection-capture' && row.payloadAck.outcome === 'confirmed') ? reduceSubseaInspection(r.path, r.trace) : null
  return { definition, status: r.status, fault: r.fault, rows, transitions: structuredClone(r.transitions), payloads: [...requests.values()], authorityState: r.authority.state, snapshotsStale: r.status === 'host-lost', boardNeutral: r.board.actuators.every((n, i) => n === p.actuators[i]!.neutral), boardFault: r.board.fault, physicalActuationEnabled: false as const, survey, inspection, navigationEvidence: r.navigationEvidence, minimumTimeMs: rows[0]?.atMs ?? 600, maximumTimeMs: rows.at(-1)?.atMs ?? 600,
    ...(vtolRun ? { vtol: { demonstrationMatched: vtolRun.report.demonstrationMatched, landingContact: vtolRun.report.landingContact, operatorEvidence: vtolRun.report.operatorEvidence ?? null, scenarioEvidence: vtolRun.report.scenarioEvidence ?? null } } : {}) }
}
export type MissionWorkspaceRecording = ReturnType<typeof runMissionWorkspace>
/** North-up route projection. Both planned goals and estimated recordings share a square metre scale. */
export function missionWorkspacePlot(definition: ReturnType<typeof getMissionWorkspaceDefinition>, rows: WorkspaceRow[]) {
  const points = [[0, 0, 0], ...definition.tasks.flatMap(t => t.targetM ? [t.targetM] : []), ...rows.map(row => row.positionM)]
  const minN = Math.min(...points.map(p => p[0]!)), maxN = Math.max(...points.map(p => p[0]!)), minE = Math.min(...points.map(p => p[1]!)), maxE = Math.max(...points.map(p => p[1]!))
  const span = Math.max(1, maxN - minN, maxE - minE), centerN = (minN + maxN) / 2, centerE = (minE + maxE) / 2
  const project = (p: number[]) => ({ x: 180 + (p[1]! - centerE) / span * 280, y: 180 - (p[0]! - centerN) / span * 280 })
  const sampleEvery = Math.max(1, Math.ceil(rows.length / 700))
  return { estimated: rows.filter((_, i) => i % sampleEvery === 0 || i === rows.length - 1).map(row => { const p = project(row.positionM); return `${p.x.toFixed(2)},${p.y.toFixed(2)}` }).join(' '), tasks: definition.tasks.filter(t => t.targetM).map(t => ({ id: t.id, ...project(t.targetM!) })), current: rows.length ? project(rows.at(-1)!.positionM) : null, spanM: span }
}
