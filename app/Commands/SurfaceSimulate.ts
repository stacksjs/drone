import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createSurfaceProfile, surfaceScenarios } from '../../resources/functions/drone/vehicles/surface/index'
import type { SurfaceScenario } from '../../resources/functions/drone/vehicles/surface/index'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
export default defineCommand({
  name: 'surface:simulate',
  description: 'Run the owned surface survey, scoped water sample and harbour return on the shared simulation runtime',
  options: {
    '--scenario <name>': { description: surfaceScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '120' },
  },
  handle(options) {
    try {
      const seconds = Number(options.seconds), scenario = options.scenario as SurfaceScenario
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 180) throw new RangeError('Surface duration must be 2..180 seconds')
      const run = runVehicleSimulation(createSurfaceProfile(scenario), { scenario, seconds })
      print(JSON.stringify({ vehicle: 'surface', scenario, status: run.status, fault: run.fault, mission: run.mission, authority: run.authority, board: run.board, recordedMissionRows: run.trace.rows.length, evaluatedPathRows: run.path.length, physicalValidation: false }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['nominal', 'harbour-return', 'current'].includes(scenario) ? 'completed' : scenario === 'host-loss' ? 'host-lost' : 'blocked'
      if (run.status !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
