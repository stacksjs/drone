import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import type { CinemaRun, CinemaScenario } from '../../resources/functions/drone/cinema/runtime'
import { cinemaScenarios, simulateCinema } from '../../resources/functions/drone/cinema/runtime'

export default defineCommand({
  name: 'cinema:simulate',
  description: 'Preview an owned hover POI angular reframe with modeled joints and still captures',
  options: { '--scenario <name>': { description: 'Closed modeled cinema scenario', default: 'nominal' } },
  async handle(options) {
    try {
      const scenario: unknown = options.scenario
      if (typeof scenario !== 'string' || !cinemaScenarios.includes(scenario as CinemaScenario)) throw new TypeError('cinema-input')
      const run = simulateCinema({ scenario })
      const text = summaryText(run)
      if (run.status !== 'completed') process.exitCode = 1
      await printAsync(text)
    }
    catch {
      process.exitCode = 1
      await printErrorAsync('Cinema simulation failed: invalid input, unavailable result or output failure')
    }
  },
})

function summaryText(run: CinemaRun) {
  const s = run.shot
  const summary = { version: run.version, evidence: run.evidence, profile: run.profile, scenario: run.scenario, status: run.status, reason: run.reason, physicalFlightEnabled: run.physicalFlightEnabled, physicalGimbalActuationEnabled: run.physicalGimbalActuationEnabled, identityAuthenticated: run.identityAuthenticated, selection: structuredClone(run.selection), clock: structuredClone(run.model.clock), mission: { state: run.mission.terminalState, reason: run.mission.terminalReason, boardNeutral: run.mission.boardNeutral }, shot: { phase: s.phase, loiterObservedAtMs: s.loiterObservedAtMs, latestStartMs: s.latestStartMs, startedAtMs: s.startedAtMs, completedAtMs: s.completedAtMs, reference: s.reference, firstFault: s.firstFault ? structuredClone(s.firstFault) : null, retirementAtMs: s.retirement.atMs, retirementCause: s.retirement.cause, counters: structuredClone(s.counters) }, captures: run.captures.map(c => ({ sequence: c.sequence, state: c.state, reason: c.reason, issuedAtMs: c.issuedAtMs, capturedAtMs: c.capturedAtMs, acknowledgedAtMs: c.ack?.acknowledgedAtMs ?? null, receivedAtMs: c.ack?.receivedAtMs ?? null, postStepAdmission: c.postStepAdmission, quality: structuredClone(c.quality) })), reconciliation: structuredClone(run.reconciliation), evaluation: structuredClone(run.evaluation) }
  const text = JSON.stringify(summary)
  if (new TextEncoder().encode(text + '\n').length > 16384) throw new RangeError('cinema-unqualified-result')
  return text
}
