import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { airScenarios, createAirProfile } from '../../resources/functions/drone/vehicles/air'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
export default defineCommand({
  name: 'air:simulate',
  description: 'Exercise our aerodynamic fixed-wing trainer on the owned sensor, estimator, mission and authority runtime',
  options: {
    '--scenario <name>': { description: airScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '120' },
  },
  handle(options) {
    try {
      const result = runVehicleSimulation(createAirProfile(options.scenario), { scenario: options.scenario, seconds: Number(options.seconds) })
      const { trace, path, ...report } = result
      print(JSON.stringify({ ...report, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['nominal', 'crosswind'].includes(options.scenario) ? 'completed' : options.scenario === 'host-loss' ? 'host-lost' : 'blocked'
      if (result.status !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
