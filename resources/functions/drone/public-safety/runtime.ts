import type { MissionSimulationContext } from '../missions/simulation'
import type { PublicSafetyPlan } from './types'
import type { PublicSafetyEpoch, PublicSafetyEvent, PublicSafetyRun, PublicSafetyScenario, PublicSafetyUpdate } from './runtime-types'
import { simulateSurvey } from '../mapping/runtime'
import { volumeInsideRing } from '../volumes/geometry'
import { examplePublicSafetyConfig } from './fixtures'
import { planPublicSafetyMission, publicSafetySessionId } from './planner'
import { createPublicSafetyCamera } from './camera'
import { publicSafetyScenarios } from './runtime-types'

/** Position uncertainty is a declared fixture bound, not qualified physical navigation. */
function publicSafetyEpochDecision(plan: PublicSafetyPlan, input: Omit<PublicSafetyEpoch, 'decision' | 'reason'>): Pick<PublicSafetyEpoch, 'decision' | 'reason'> {
  const stop = (reason: string) => ({ decision: 'stop' as const, reason })
  if (!input.link.connected || input.atMs - input.link.capturedAtMs > 150) return stop('incident-control-link-unavailable')
  if (input.battery.remainingPercent <= plan.config.survey.power.reservePercent) return stop('incident-battery-reserve')
  if (input.remainingFlightMs !== null && input.remainingFlightMs <= 0) return stop('incident-endurance-requires-new-pilot-acceptance')
  if (input.incidentRevision !== plan.config.revision) return stop('incident-revision-requires-new-pilot-acceptance')
  if (input.authority !== 'autonomous') return stop('incident-supervised-authority-unavailable')
  if (!input.positionM || input.positionSigmaM === null) return stop('incident-position-unqualified')
  const p = input.positionM, ring = plan.config.operatingBoundary
  if (!volumeInsideRing([p[0], p[1]], ring)) return stop('incident-operating-boundary')
  const margin = 3 * input.positionSigmaM
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const dn = b[0] - a[0], de = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dn + (p[1] - a[1]) * de) / (dn * dn + de * de)))
    if (Math.hypot(p[0] - a[0] - t * dn, p[1] - a[1] - t * de) <= margin) return stop('incident-boundary-uncertainty')
  }
  return { decision: 'continue', reason: 'incident-scope-and-resources-current' }
}

/** Run the actual owned loop. Events are emitted during virtual execution, never presented as a real transport feed. */
export function simulatePublicSafety(options: { config?: unknown, scenario?: PublicSafetyScenario, seconds?: number, onEvent?: (event: PublicSafetyEvent) => void } = {}): PublicSafetyRun {
  const scenario = options.scenario ?? 'nominal', seconds = options.seconds ?? 100
  if (!publicSafetyScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120 || (options.onEvent !== undefined && typeof options.onEvent !== 'function')) throw new RangeError('Invalid public-safety scenario, duration or event consumer')
  const plan = planPublicSafetyMission(options.config === undefined ? examplePublicSafetyConfig() : options.config)
  if (plan.config.survey.calibration.evidence !== 'synthetic') throw new TypeError('Public-safety simulation requires synthetic camera calibration')
  // IDs are validated separately by the planner. A digest-free bounded scope does not authenticate its producer.
  const sessionId = publicSafetySessionId(plan.config)
  const source = createPublicSafetyCamera(plan, scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none')
  const epochs: PublicSafetyEpoch[] = [], events: PublicSafetyEvent[] = [], updates: PublicSafetyUpdate[] = []
  // Camera/sensor/manual thresholds belong to the reused fixtures. Incident changes are scheduled from the first ACK below.
  let faultAtMs: number | null = scenario === 'camera-loss' || scenario === 'wrong-ack' || scenario === 'position-loss' ? 12000 : scenario === 'manual' ? 5000 : null
  let confirmed = 0, consumerFailed = false, incidentRevision = plan.config.revision
  let faultExercised = false
  const emit = (kind: PublicSafetyEvent['kind'], atMs: number, captureId: string | null = null) => {
    const event: PublicSafetyEvent = { sequence: events.length + 1, atMs, kind, captureId, observationCount: epochs.length, captureCount: confirmed, incidentRevision }
    events.push(event)
    if (options.onEvent) {
      try {
        const result: unknown = options.onEvent(structuredClone(event))
        if (result !== undefined) {
          if (result instanceof Promise) void result.catch(() => {})
          throw new TypeError('Event consumers must be synchronous and return no value')
        }
      }
      catch { consumerFailed = true; throw new Error('Public-safety event consumer failed') }
    }
  }
  const affected = (nowMs: number) => faultAtMs !== null && nowMs >= faultAtMs
  const epoch = (context: MissionSimulationContext) => {
    const { nowMs, estimate } = context
    const changed = affected(nowMs) && (scenario === 'boundary-change' || scenario === 'endurance-change')
    if (changed && !updates.length) {
      // Revisions invalidate the accepted plan. No graph is silently edited and no successor mission is auto-accepted.
      const next = plan.config.revision === 'revision-updated' ? 'revision-updated-2' : 'revision-updated'
      const boundary = plan.config.operatingBoundary
      const centerNorth = boundary.reduce((sum, point) => sum + point[0], 0) / boundary.length
      const centerEast = boundary.reduce((sum, point) => sum + point[1], 0) / boundary.length
      updates.push({
        sequence: 1, atMs: nowMs, incidentId: plan.config.id, visitId: plan.config.visitId, previousRevision: incidentRevision, revision: next, kind: scenario,
        operatingBoundary: scenario === 'boundary-change' ? boundary.map(point => [centerNorth + (point[0] - centerNorth) * .5, centerEast + (point[1] - centerEast) * .5]) : null,
        remainingFlightMs: scenario === 'endurance-change' ? 0 : null, requiresNewPilotAcceptance: true,
      })
      incidentRevision = next
      emit('incident-update', nowMs)
    }
    const p = estimate.localPosition
    const input: Omit<PublicSafetyEpoch, 'decision' | 'reason'> = {
      atMs: nowMs, positionM: p && p.positionM.length === 3 && p.positionM.every(Number.isFinite) ? [p.positionM[0]!, p.positionM[1]!, p.positionM[2]!] : null,
      positionSigmaM: p ? Math.sqrt(Math.max(...p.covarianceBlocks.map(block => block.positionM2))) : null,
      authority: context.authority, battery: structuredClone(context.battery), link: structuredClone(context.link),
      missionState: context.mission.state, taskId: context.mission.taskId, incidentRevision,
      remainingFlightMs: changed && scenario === 'endurance-change' ? 0 : null,
    }
    const decision = publicSafetyEpochDecision(plan, input)
    epochs.push({ ...input, ...decision }); emit('mission-observation', nowMs)
    if (affected(nowMs)) faultExercised = true
    return decision.decision === 'stop' ? 'abort' as const : undefined
  }
  const survey = simulateSurvey({
    config: plan.config.survey, seconds, sessionId, sensorLossAfterMs: scenario === 'position-loss' ? 12000 : undefined,
    scenario: scenario === 'position-loss' ? 'position-loss' : scenario === 'manual' ? 'rc-override' : 'nominal',
    cameraFactory: () => source.camera,
    observation(nowMs) {
      const active = affected(nowMs)
      return {
        link: { capturedAtMs: active && scenario === 'link-stale' ? faultAtMs! - 160 : nowMs, connected: !(active && scenario === 'link-loss') },
        ...(active && scenario === 'battery-loss' ? { battery: { capturedAtMs: nowMs, remainingPercent: 20 } } : {}),
      }
    },
    observe: epoch,
    onCapture(capture, context) {
      confirmed++
      // Loss is anchored to actual acknowledged evidence rather than an assumed route timing.
      if (scenario !== 'nominal' && faultAtMs === null) faultAtMs = context.nowMs + 1000
      emit('capture-confirmed', context.nowMs, capture.id)
    },
  })
  if (consumerFailed) throw new Error('Public-safety event consumer failed; modeled outputs were revoked')
  const received = source.thermalAcks()
  const matches = (ack: typeof received[number], visible: typeof survey.captures[number]) => ack.sessionId === sessionId && ack.sessionId === visible.sessionId && ack.sequence === visible.sequence && ack.reference === visible.pose.reference && ack.issuedAtMs === visible.issuedAtMs && ack.capturedAtMs === visible.capturedAtMs && ack.acknowledgedAtMs === visible.acknowledgedAtMs
  const captures = survey.captures.map(visible => {
    const joined = received.filter(ack => matches(ack, visible))
    if (joined.length !== 1) throw new Error('Public-safety numeric and visible capture scopes differ')
    return joined[0]!
  })
  // A rejected ACK remains uncertain evidence, without an authoritative geotagged capture.
  const unmatchedAcks = received.filter(ack => !survey.captures.some(visible => matches(ack, visible)))
  const final = survey.trace.rows.at(-1)!
  const sourceFault = scenario === 'camera-loss' ? survey.reason === 'camera-ack-deadline' && final.observation.nowMs >= 12080
    : scenario === 'wrong-ack' ? survey.reason === 'camera-ack-scope-or-timing' && unmatchedAcks.length > 0 && final.observation.nowMs >= 12020
      : scenario === 'position-loss' ? final.observation.nowMs >= 12000 && !final.observation.healthy
        : scenario === 'manual' ? final.observation.nowMs >= 5000 && final.observation.authority === 'manual'
          : faultExercised
  const faultDemonstrated = scenario !== 'nominal' && (confirmed > 0 || scenario === 'manual') && ['blocked', 'aborted'].includes(survey.status) && survey.boardNeutral && sourceFault
  return { version: 1, evidence: 'owned-public-safety-physics-simulation', physicalFlightEnabled: false, physicalThermalVerified: false, identityAuthenticated: false, replayProfile: 'owned-public-safety-collection-v1', plan, scenario, seconds, sessionId, survey, captures, unmatchedAcks, epochs, updates, events, faultAtMs, faultDemonstrated }
}
