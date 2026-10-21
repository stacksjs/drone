import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import type { CinemaCountedTranslationRun } from '../../resources/functions/drone/cinema/runtime'
import { simulateCountedTranslatingCinema } from '../../resources/functions/drone/cinema/runtime'

export default defineCommand({
  name: 'cinema:translate',
  description: 'Preview the owned counted POI dolly and selected-source expiry simulation',
  options: { '--scenario <name>': { description: 'nominal or source-expiry-with-foreign', default: 'nominal' } },
  async handle(options) {
    try {
      const scenario: unknown = options.scenario
      if (scenario !== 'nominal' && scenario !== 'source-expiry-with-foreign') throw new TypeError('cinema-counted-translation-input')
      const run = simulateCountedTranslatingCinema({ scenario })
      const text = summaryText(run)
      if (run.status !== 'completed') process.exitCode = 1
      await printAsync(text)
    }
    catch {
      process.exitCode = 1
      await printErrorAsync('Counted cinema simulation failed: invalid input, unavailable result or output failure')
    }
  },
})

function summaryText(run: CinemaCountedTranslationRun): string {
  const s = run.shot, manager = run.manager, translation = run.translation, accepted = manager.lastAccepted
  const summary = {
    version: 1,
    evidence: 'owned-counted-cinema-cli-summary',
    run: {
      version: run.version,
      evidence: run.evidence,
      profile: run.profile,
      scenario: run.scenario,
      status: run.status,
      reason: run.reason,
      physicalFlightEnabled: run.physicalFlightEnabled,
      physicalGimbalActuationEnabled: run.physicalGimbalActuationEnabled,
      identityAuthenticated: run.identityAuthenticated,
    },
    clock: structuredClone(run.model.clock),
    encoderMethod: structuredClone(run.model.encoderMeasurement),
    mission: {
      version: run.mission.trace.version,
      planId: run.mission.trace.plan.id,
      state: run.mission.terminalState,
      reason: run.mission.terminalReason,
      boardNeutral: run.mission.boardNeutral,
      boardFault: run.mission.boardFault,
      finalTruthPositionM: [...run.mission.finalTruthPositionM],
    },
    shot: {
      phase: s.phase,
      loiterObservedAtMs: s.loiterObservedAtMs,
      latestStartMs: s.latestStartMs,
      readySinceMs: s.readySinceMs,
      readySampleCount: s.readySampleCount,
      startedAtMs: s.startedAtMs,
      completedAtMs: s.completedAtMs,
      firstFault: structuredClone(s.firstFault),
      counters: structuredClone(s.counters),
      retirement: { atMs: s.retirement.atMs, cause: s.retirement.cause, requestedTorqueNm: [...s.retirement.requestedTorqueNm] },
    },
    manager: {
      firstInhibit: structuredClone(manager.firstInhibit),
      counters: structuredClone(manager.counters),
      retirement: structuredClone(manager.retirement),
      lastAccepted: accepted ? { epoch: accepted.epoch, sequence: accepted.sequence, issuedAtMs: accepted.issuedAtMs, expiresAtMs: accepted.expiresAtMs } : null,
    },
    translation: {
      version: translation.version,
      evidence: translation.evidence,
      frame: translation.frame,
      fromM: [...translation.fromM],
      toM: [...translation.toM],
      planDefaultSpeedMps: translation.planDefaultSpeedMps,
      taskRates: structuredClone(translation.taskRates),
      policy: structuredClone(translation.policy),
      timeline: structuredClone(translation.timeline),
      metrics: structuredClone(translation.metrics),
      smoothnessQualified: translation.smoothnessQualified,
    },
    captures: run.captures.map(c => ({
      sequence: c.sequence,
      state: c.state,
      reason: c.reason,
      shotOffsetMs: c.shotOffsetMs,
      issuedAtMs: c.issuedAtMs,
      capturedAtMs: c.capturedAtMs,
      deadlineMs: c.deadlineMs,
      acknowledgedAtMs: c.ack?.acknowledgedAtMs ?? null,
      receivedAtMs: c.ack?.receivedAtMs ?? null,
      postStepAdmission: c.postStepAdmission,
      quality: structuredClone(c.quality),
      bodyPositionM: c.actual ? [...c.actual.bodyPositionM] : null,
      encoder: {
        version: c.encoder.version,
        sequence: c.encoder.sequence,
        capturedAtMs: c.encoder.capturedAtMs,
        receivedAtMs: c.encoder.receivedAtMs,
        positionCounts: [...c.encoder.positionCounts],
        deltaCounts: c.encoder.deltaCounts ? [...c.encoder.deltaCounts] : null,
        velocityRadS: c.encoder.velocityRadS ? [...c.encoder.velocityRadS] : null,
      },
    })),
    reconciliation: structuredClone(run.reconciliation),
    evaluation: structuredClone(run.evaluation),
  }
  const text = JSON.stringify(summary)
  if (new TextEncoder().encode(text + '\n').length > 16384) throw new RangeError('cinema-unqualified-result')
  return text
}
