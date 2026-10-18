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
      print(JSON.stringify(await runVehicleSimulation(createGroundProfile(options.scenario), { scenario: options.scenario, seconds: Number(options.seconds) }), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
