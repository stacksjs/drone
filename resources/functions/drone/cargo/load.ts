import type { CargoLoadCase, CargoLoadRun, CargoLoadSummary } from './types'
import { simulateMultirotor } from '../controls/simulation'

export const cargoLoadScenarios = ['centered-carried', 'forward-carried', 'forward-separated', 'link-loss'] as const

function captureCargoInput(input: unknown): CargoLoadCase {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const keys = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input)
    if (keys.some(key => key !== 'scenario')) throw new TypeError()
    if (keys.length === 0) return 'centered-carried'
    const descriptor = descriptors.scenario
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !cargoLoadScenarios.includes(descriptor.value as CargoLoadCase)) throw new TypeError()
    return descriptor.value as CargoLoadCase
  }
  catch { throw new TypeError('cargo-load-input') }
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length }
function assertCargoRunBounds(run: CargoLoadRun) {
  if (run.physical.length > 5001 || run.policy.length > 1001 || run.evaluation.reasons.length > 8
    || run.physical.some(row => bytes(row) > 2048) || run.policy.some(row => bytes(row) > 2048)
    || bytes({ ...run, physical: [], policy: [] }) > 131072 || bytes(run) + 1 > 12582912) throw new RangeError('cargo-load-unavailable')
}

/** One owned simulation; this is a carried-load prerequisite, with no physical delivery or release IO. */
export function simulateCargoLoad(input: unknown = {}): CargoLoadRun {
  const scenario = captureCargoInput(input)
  try {
    const evidence = simulateMultirotor({ cargoLoadCase: scenario }).cargoLoadEvidence
    const projected: CargoLoadRun = {
      version: 1, evidence: 'owned-airborne-cargo-load-characterization', profile: 'forward-point-load-v1', scenario: evidence.scenario,
      status: scenario === 'link-loss' || evidence.evaluation.reasons.length > 0 ? 'unqualified' : 'characterized', reason: evidence.evaluation.reasons[0] ?? null,
      physicalFlightEnabled: false, boardOutputsInhibited: true, identityAuthenticated: false,
      capabilities: { deliveryPerformed: false, releaseMechanismVerified: false, custodyVerified: false, recipientConfirmed: false, missionExecuted: false, energyMarginQualified: false },
      model: evidence.model, counts: evidence.counts, separation: evidence.separation, physical: evidence.physical, policy: evidence.policy, evaluation: evidence.evaluation, final: evidence.final,
    }
    const run = structuredClone(projected)
    assertCargoRunBounds(run)
    return run
  }
  catch { throw new RangeError('cargo-load-unavailable') }
}

/** Compact projection of an owned run; no row arrays or event kinematics are printed by the command. */
export function cargoLoadSummary(run: CargoLoadRun): CargoLoadSummary {
  try {
    const projected: CargoLoadSummary = {
      version: 1, evidence: 'owned-airborne-cargo-load-characterization', profile: 'forward-point-load-v1', scenario: run.scenario, status: run.status, reason: run.reason,
      physicalFlightEnabled: false, boardOutputsInhibited: true, identityAuthenticated: false, capabilities: run.capabilities, model: run.model, counts: run.counts,
      separation: { scheduledAtMs: run.separation.scheduledAtMs, attemptedAtMs: run.separation.attemptedAtMs, outcome: run.separation.outcome, reason: run.separation.reason, beforeProperties: run.separation.before?.properties ?? null, afterProperties: run.separation.after?.properties ?? null },
      metrics: run.evaluation.metrics,
      final: { authorityState: run.final.supervisor.state, authorityReason: run.final.supervisor.reason, boardFault: run.final.board.fault, boardMotorsN: run.final.board.motorsN, boardExpiresAtMs: run.final.board.expiresAtMs, loadPhase: run.final.load.properties.phase, bodyPositionM: run.final.body.positionM, bodyVelocityMps: run.final.body.velocityMps, experimentEnded: true, landingPerformed: false },
    }
    const summary = structuredClone(projected)
    if (bytes(summary) + 1 > 16384) throw new RangeError()
    return summary
  }
  catch { throw new RangeError('cargo-load-unavailable') }
}
