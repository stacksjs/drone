import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createGroundProfile, groundScenarios } from '../../resources/functions/drone/vehicles/ground/profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

export default defineCommand({
  name: 'ground:simulate',
  description: 'Run the owned differential ground mission, implement and failsafe simulation',
  options: {
    '--scenario <name>': { description: groundScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Integer virtual duration, 2..180 seconds', default: '120' },
  },
  async handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds) || Number(options.seconds) < 2 || Number(options.seconds) > 180) throw new RangeError('Ground simulation seconds must be an integer from 2 to 180')
      const result = await runVehicleSimulation(createGroundProfile(options.scenario), { scenario: options.scenario, seconds: Number(options.seconds) })
      const { trace, path, ...report } = result
      print(JSON.stringify({ ...report, recordedMissionRows: trace.rows.length, evaluatedPathRows: path.length }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['nominal', 'logistics'].includes(options.scenario) ? 'completed' : options.scenario === 'host-loss' ? 'host-lost' : 'blocked'
      if (result.status !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
