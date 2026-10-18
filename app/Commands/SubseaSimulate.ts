import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { writeFile } from '@stacksjs/storage/files'
import { createSubseaProfile, reduceSubseaInspection, subseaScenarios } from '../../resources/functions/drone/vehicles/subsea/index'
import type { SubseaScenario } from '../../resources/functions/drone/vehicles/subsea/index'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

export default defineCommand({
  name: 'subsea:simulate',
  description: 'Run the owned pressure and DVL inspection ROV on the shared modeled runtime',
  options: {
    '--scenario <name>': { description: subseaScenarios.join(', '), default: 'nominal' },
    '--inspection <file>': 'Export scoped synthetic P5 image pixels, sonar ranges, owned capture poses and declared uncertainty as JSON',
    '--position-sigma <n>': { description: 'Declared fixture position sigma in metres, not measured covariance', default: '0.1' },
    '--attitude-sigma <n>': { description: 'Declared fixture attitude sigma in radians', default: '0.02' },
    '--clock-sigma <n>': { description: 'Declared fixture capture time sigma in milliseconds, at least sensor-declared 1 ms', default: '2' },
    '--range-sigma <n>': { description: 'Declared fixture single-range sigma in metres', default: '0.05' },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '120' },
  },
  async handle(options) {
    try {
      const seconds = Number(options.seconds), scenario = options.scenario as SubseaScenario
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 180) throw new RangeError('Subsea duration must be 2..180 seconds')
      const uncertainty = { positionSigmaM: Number(options.positionSigma), attitudeSigmaRad: Number(options.attitudeSigma), timeSigmaMs: Number(options.clockSigma), rangeSigmaM: Number(options.rangeSigma) }
      if (Object.values(uncertainty).some(n => !Number.isFinite(n) || n < 0) || uncertainty.positionSigmaM > 10 || uncertainty.attitudeSigmaRad > 0.5 || uncertainty.timeSigmaMs < 1 || uncertainty.timeSigmaMs > 100 || uncertainty.rangeSigmaM > 10) throw new RangeError('Invalid declared inspection uncertainty')
      const run = runVehicleSimulation(createSubseaProfile(scenario), { scenario, seconds })
      let exportedFrames = 0
      if (options.inspection) {
        const inspection = reduceSubseaInspection(run.path, run.trace, uncertainty)
        await writeFile(options.inspection, `${JSON.stringify(inspection, null, 2)}\n`)
        exportedFrames = inspection.frames.length
      }
      print(JSON.stringify({ inspectionFile: options.inspection ?? null, exportedFrames, vehicle: 'subsea', scenario, status: run.status, fault: run.fault, mission: run.mission, navigationEvidence: run.navigationEvidence, authority: run.authority, board: run.board, recordedMissionRows: run.trace.rows.length, evaluatedPathRows: run.path.length, physicalValidation: false }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['nominal', 'current'].includes(scenario) ? 'completed' : scenario === 'host-loss' ? 'host-lost' : 'blocked'
      if (run.status !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
