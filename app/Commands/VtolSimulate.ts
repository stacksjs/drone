import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { runVtolSimulation, vtolSimulationPhases, vtolSimulationScenarios } from '../../resources/functions/drone/vehicles/vtol/simulation'

export default defineCommand({
  name: 'vtol:simulate',
  description: 'Exercise the fictional owned front/cruise/back/landing route; no physical control',
  options: {
    '--scenario <name>': { description: vtolSimulationScenarios.join(', '), default: 'nominal' },
    '--phase <name>': { description: `Observed wind onset or fault injection: ${vtolSimulationPhases.join(', ')}; wind also accepts startup (default, 1000 ms); faults default front` },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds; default 160, or 180 for recovery hold' },
    '--electrical': { description: 'Use fictional electrical load and delayed battery measurements; all planned capture cases include this model', default: false },
  },
  async handle(options) {
    try {
      const report = runVtolSimulation(options.scenario, { seconds: options.seconds === undefined ? undefined : Number(options.seconds), electrical: options.electrical, phase: options.phase })
      await printAsync(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      if (!report.demonstrationMatched) process.exitCode = 1
    }
    catch (error) {
      process.exitCode = 1
      try { await printErrorAsync(error instanceof Error ? error.message : String(error)) }
      catch { /* Keep the failure status when the error pipe cannot receive a diagnostic. */ }
    }
  },
})
