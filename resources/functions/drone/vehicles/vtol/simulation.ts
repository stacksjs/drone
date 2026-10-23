import { createVtolTransitionProfile } from './transition-profile'
import { runVehicleSimulation } from '../runtime'
import type { VehicleMissionAction } from '../types'

const faults = { 'host-loss': 'hostLost', 'imu-loss': 'dropImu', 'position-loss': 'dropPosition', 'vehicle-sensor-loss': 'dropVehicleSensor', 'rc-override': 'rcOverride', 'kill': 'kill' } as const
interface OperatorCase { actions: readonly { atMs: number, action: Exclude<VehicleMissionAction, 'start'> }[], recovery?: 'front' | 'back', outcome: 'abort' | 'resume' | 'timeout' | 'hold-expiry', openCircuit?: boolean, seconds?: number }
const operatorCases = {
  'cruise-pause-resume': { actions: [{ atMs: 20000, action: 'pause' }, { atMs: 40000, action: 'resume' }], outcome: 'resume' },
  'front-abort': { actions: [{ atMs: 13000, action: 'abort' }], recovery: 'front', outcome: 'abort' },
  'back-abort': { actions: [{ atMs: 30000, action: 'abort' }], recovery: 'back', outcome: 'abort' },
  'front-recover-resume': { actions: [{ atMs: 13000, action: 'recover' }, { atMs: 40000, action: 'resume' }], recovery: 'front', outcome: 'resume' },
  'back-recover-resume': { actions: [{ atMs: 30000, action: 'recover' }, { atMs: 80000, action: 'resume' }], recovery: 'back', outcome: 'resume' },
  'pusher-open-circuit': { actions: [], recovery: 'front', outcome: 'timeout', openCircuit: true },
  'back-recovery-hold': { actions: [{ atMs: 30000, action: 'recover' }], recovery: 'back', outcome: 'hold-expiry', seconds: 180 },
} as const satisfies Record<string, OperatorCase>
export const vtolSimulationScenarios = Object.freeze(['nominal', ...Object.keys(faults), ...Object.keys(operatorCases)])
export const vtolSimulationPhases = Object.freeze(['front', 'cruise', 'back', 'landing'] as const)
const phases = [
  { phase: 'front', atMs: 13000, taskId: 'front' },
  { phase: 'cruise', atMs: 20000, taskId: 'cruise-leg' },
  { phase: 'back', atMs: 30000, taskId: 'back' },
  { phase: 'landing', atMs: 68000, taskId: 'land' },
] as const
interface SourceEpochs { atMs: number, attitudeCapturedAtMs: number | null, positionCapturedAtMs: number | null, measurementCapturedAtMs: number | null }

export interface VtolSimulationOptions { seconds?: number, electrical?: boolean, phase?: string }

/** One case construction shared by CLI reports and the recorded workspace. No session is allocated until run. */
export function createVtolSimulationCase(scenario = 'nominal', options: VtolSimulationOptions = {}) {
  if (!(vtolSimulationScenarios as readonly string[]).includes(scenario)) throw new RangeError('Unknown VTOL simulation scenario')
  if (options.phase !== undefined && !(vtolSimulationPhases as readonly string[]).includes(options.phase)) throw new RangeError('Unknown VTOL simulation phase')
  const faultCase = Object.hasOwn(faults, scenario)
  if (!faultCase && options.phase !== undefined) throw new RangeError('VTOL phase selection requires a fault scenario')
  const phase = faultCase ? phases.find(row => row.phase === (options.phase ?? 'front')) : null
  if (phase === undefined) throw new RangeError('Unknown VTOL simulation phase')
  const profile = createVtolTransitionProfile({ electrical: options.electrical })
  const operator: OperatorCase | undefined = Object.hasOwn(operatorCases, scenario) ? operatorCases[scenario as keyof typeof operatorCases] : undefined
  const actions = operator?.actions
  if (operator?.recovery) {
    const source = profile.mission.tasks.find(task => task.id === operator.recovery)
    if (!source || source.kind !== 'vtol-mode') throw new TypeError('Missing VTOL recovery source')
    source.onFailure = 'recover-hover'
    const back = operator.recovery === 'back'
    profile.mission.tasks.push(
      { id: 'recover-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: back ? 40000 : 45000, next: 'recover-land' },
      { id: 'recover-land', kind: 'land', positionM: [back ? 180 : 0, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: back ? 30000 : 35000 },
    )
  }
  if (scenario !== 'nominal') { profile.scenario = scenario; profile.scenarios = vtolSimulationScenarios }
  const sources: { last: SourceEpochs | null } = { last: null }
  if (phase) {
    const fault = faults[scenario as keyof typeof faults], factory = profile.createSession
    profile.faults = (_scenario, atMs) => atMs >= phase.atMs ? { [fault]: true } : {}
    profile.createSession = () => {
      const session = factory()
      return { ...session, createController() {
        const controller = session.createController()
        return { step(context) {
          sources.last = { atMs: context.nowMs, attitudeCapturedAtMs: context.estimate.attitude?.capturedAtMs ?? null, positionCapturedAtMs: context.estimate.localPosition?.capturedAtMs ?? null, measurementCapturedAtMs: context.measurement?.capturedAtMs ?? null }
          return controller.step(context)
        } }
      } }
    }
  }
  if (operator?.openCircuit) {
    const factory = profile.createSession
    profile.createSession = () => {
      const session = factory()
      return { ...session, createPlant() {
        const plant = session.createPlant()
        return { snapshot: () => plant.snapshot(), step(input, dtS, world) {
          const demand = [...input]
          demand[4] = 0
          return plant.step(demand, dtS, world)
        } }
      } }
    }
  }
  const seconds = options.seconds ?? operator?.seconds ?? 160
  return { profile, seconds, phase: phase?.phase ?? null, electrical: options.electrical ?? false, run() {
    sources.last = null
    const result = runVehicleSimulation(profile, { seconds, missionActions: actions })
    const { trace, path, ...report } = result
    const transitionEvidence = trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [row.observation.transition] : [])
    const confirmed = (tasks: readonly string[]) => transitionEvidence.length === tasks.length && transitionEvidence.every((row, index) => row.taskId === tasks[index] && row.phase === (row.taskId === 'front' ? 'cruise' : 'hover'))
    const completeTransitions = confirmed(['initial-hover', 'front', 'back'])
    const observedFlight = path.some(row => row.positionM && row.positionM[2] < -1 && row.actuators.slice(0, 4).some(n => n > 0))
    const landingContact = path.at(-1)?.measurement?.values.onSurface === true
    const boardNeutral = result.board.actuators.every(n => n === 0) && result.board.expiresAtMs === null
    const before = phase ? path.find(row => row.atMs === phase.atMs - 20) : undefined
    // The controller callback captures epochs while the synchronous runtime runs.
    const capturedSources = sources.last as SourceEpochs | null
    let faultObserved = false
    if (phase && before?.mission.taskId === phase.taskId) {
      if (scenario === 'host-loss') faultObserved = result.status === 'host-lost' && result.board.fault === 'output-lease-expired' && result.board.lastCheckedAtMs !== null && result.board.lastCheckedAtMs >= phase.atMs + 100 && result.authority.lastCheckedAtMs !== null && result.authority.lastCheckedAtMs < phase.atMs
      else if (result.status === 'blocked' && capturedSources && capturedSources.atMs >= phase.atMs && capturedSources.atMs <= phase.atMs + 500) {
        const last = capturedSources
        const lost = (epoch: number | null) => epoch === null || epoch < phase.atMs
        if (scenario === 'imu-loss') faultObserved = lost(last.attitudeCapturedAtMs)
        if (scenario === 'position-loss') faultObserved = lost(last.positionCapturedAtMs) && !lost(last.attitudeCapturedAtMs)
        if (scenario === 'vehicle-sensor-loss') faultObserved = lost(last.measurementCapturedAtMs) && !lost(last.attitudeCapturedAtMs) && !lost(last.positionCapturedAtMs)
        if (scenario === 'rc-override' || scenario === 'kill') faultObserved = trace.rows.some(row => row.observation.nowMs === phase.atMs && row.observation.authority === (scenario === 'kill' ? 'killed' : 'manual'))
      }
    }
    const completedRoute = result.status === 'completed' && result.fault === null && result.mission.taskId === 'land' && result.mission.reason === 'landed' && completeTransitions && observedFlight && landingContact && boardNeutral
    const actualActions = trace.rows.flatMap(row => row.action && row.action !== 'start' ? [{ atMs: row.observation.nowMs, action: row.action }] : [])
    const tasksBeforeActions = actions?.map(action => {
      const previous = path.find(row => row.atMs === action.atMs - 20)?.mission
      return { atMs: action.atMs, taskId: previous?.taskId ?? null, state: previous?.state ?? null }
    }) ?? []
    const observedPaused = trace.rows.some(row => row.result.state === 'paused')
    const failedRequest = path.find(row => row.mission.transition?.taskId === operator?.recovery)?.mission.transition
    const replacement = path.find(row => row.mission.transition?.taskId === 'recover-hover')?.mission.transition
    const recovery = result.mission.recovery
    const recoveryCorrelated = !!operator?.recovery && !!failedRequest && !!replacement && replacement.supersedesEventId === failedRequest.eventId && recovery?.failedEventId === failedRequest.eventId && recovery.failedTaskId === operator.recovery && recovery.triggeredAtMs === (operator.outcome === 'timeout' ? failedRequest.expiresAtMs : actions?.[0]?.atMs) && recovery.cause === (operator.outcome === 'timeout' ? 'timeout' : operator.outcome === 'abort' ? 'operator-abort' : 'operator-recover')
    const recoveryReason = operator?.outcome === 'abort' ? 'vtol-abort-landed' : 'vtol-recovery-landed'
    const recoveredRoute = !!operator?.recovery && recoveryCorrelated && confirmed(operator.recovery === 'back' ? ['initial-hover', 'front', 'recover-hover'] : ['initial-hover', 'recover-hover']) && result.mission.taskId === 'recover-land' && result.mission.state === (operator.outcome === 'abort' ? 'aborted' : 'completed') && result.mission.reason === recoveryReason && result.status === (operator.outcome === 'abort' ? 'blocked' : 'completed') && result.fault === (operator.outcome === 'abort' ? recoveryReason : null) && observedFlight && landingContact && boardNeutral
    const pusherOpenCircuitObserved = !!operator?.openCircuit && path.some(row => row.actuators[4]! > 0.1) && path.every(row => row.measurement?.values.pusherThrustN === 0) && !path.some(row => row.mission.taskId === 'cruise-leg') && result.transitions.filter(row => row.taskId === 'front').length === 1
    const lastAtMs = trace.rows.at(-1)?.observation.nowMs ?? 0
    const landingStarted = path.some(row => row.mission.taskId === 'recover-land' && row.mission.state === 'running')
    const globalEnduranceExpired = operator?.outcome === 'hold-expiry' && recoveryCorrelated && confirmed(['initial-hover', 'front', 'recover-hover']) && result.status === 'blocked' && result.mission.state === 'blocked' && result.mission.reason === 'mission-endurance-exhausted' && result.fault === 'mission-endurance-exhausted' && lastAtMs > 600 + result.budget.worstCaseMs && lastAtMs <= 620 + result.budget.worstCaseMs && !landingStarted && observedFlight && !landingContact && boardNeutral
    const operatorPhaseMatched = operator?.recovery ? recoveryCorrelated : tasksBeforeActions.length === 2 && tasksBeforeActions[0]?.taskId === 'cruise-leg' && tasksBeforeActions[0].state === 'running' && tasksBeforeActions[1]?.taskId === 'cruise-leg' && tasksBeforeActions[1].state === 'paused'
    const operatorMatched = !!operator && operatorPhaseMatched && JSON.stringify(actualActions) === JSON.stringify(actions) && (!['resume', 'hold-expiry'].includes(operator.outcome) || observedPaused) && (operator.outcome === 'hold-expiry' ? globalEnduranceExpired : operator.recovery ? recoveredRoute : completedRoute) && (!operator.openCircuit || pusherOpenCircuitObserved)
    const demonstrationMatched = scenario === 'nominal' ? completedRoute : actions ? operatorMatched : faultObserved && observedFlight && !landingContact && result.mission.state !== 'completed' && boardNeutral
    const summary = { ...report, scope: 'development-lift-and-cruise' as const, transitionEvidence, completeTransitions, observedFlight, landingContact, boardNeutral, demonstrationMatched, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length,
      ...(phase ? { scenarioEvidence: { phase: phase.phase, injectedAtMs: phase.atMs, taskId: before?.mission.taskId ?? null, faultObserved, sources: capturedSources } } : {}),
      ...(actions ? { operatorEvidence: { actions: actualActions, tasksBeforeActions, phaseMatched: operatorPhaseMatched, observedPaused, matched: operatorMatched, ...(operator?.recovery ? { recoveryCorrelated } : {}), ...(operator?.openCircuit ? { pusherOpenCircuitObserved } : {}), ...(operator?.outcome === 'hold-expiry' ? { globalEnduranceExpired, landingStarted } : {}) } } : {}) }
    return { result, report: summary }
  } }
}

/** Reproducible modeled cases on the existing runtime, not a physical control endpoint. */
export function runVtolSimulation(scenario = 'nominal', options: VtolSimulationOptions = {}) {
  return createVtolSimulationCase(scenario, options).run().report
}
