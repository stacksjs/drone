import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { runVtolSimulation, vtolSimulationPhases, vtolSimulationScenarios } from '../../resources/functions/drone/vehicles/vtol/simulation'

export default defineCommand({
  name: 'vtol:simulate',
  description: 'Exercise the fictional owned front/cruise/back/landing route; no physical control',
  options: {
    '--scenario <name>': { description: vtolSimulationScenarios.join(', '), default: 'nominal' },
    '--phase <name>': { description: `Fault injection phase: ${vtolSimulationPhases.join(', ')}; default front` },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds; default 160, or 180 for recovery hold' },
    '--electrical': { description: 'Use fictional electrical load and delayed battery measurements', default: false },
  },
  handle(options) {
    try {
      const report = runVtolSimulation(options.scenario, { seconds: options.seconds === undefined ? undefined : Number(options.seconds), electrical: options.electrical, phase: options.phase })
      print(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      if (!report.demonstrationMatched) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
