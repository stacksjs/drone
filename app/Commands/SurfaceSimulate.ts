import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { writeFile } from '@stacksjs/storage/files'
import { createSurfaceProfile, reduceSurfaceSurvey, surfaceScenarios } from '../../resources/functions/drone/vehicles/surface/index'
import type { SurfaceScenario } from '../../resources/functions/drone/vehicles/surface/index'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
export default defineCommand({
  name: 'surface:simulate',
  description: 'Run the owned surface survey, scoped water sample and harbour return on the shared simulation runtime',
  options: {
    '--scenario <name>': { description: surfaceScenarios.join(', '), default: 'nominal' },
    '--survey <file>': 'Export modeled single-beam JSON with raw corrections, capture provenance and declared uncertainty',
    '--position-sigma <n>': { description: 'Declared horizontal position sigma in metres for modeled export', default: '0.05' },
    '--attitude-sigma <n>': { description: 'Declared capture-time attitude sigma in radians including gyro extrapolation', default: '0.001' },
    '--clock-sigma <n>': { description: 'Declared time sigma in milliseconds, at least sensor-declared 1 ms', default: '2' },
    '--seconds <n>': { description: 'Maximum virtual duration, 2..180 seconds', default: '120' },
  },
  async handle(options) {
    try {
      const seconds = Number(options.seconds), scenario = options.scenario as SurfaceScenario
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 180) throw new RangeError('Surface duration must be 2..180 seconds')
      const run = runVehicleSimulation(createSurfaceProfile(scenario), { scenario, seconds })
      let exportedSoundings = 0
      if (options.survey) {
        const uncertainty = { positionSigmaM: Number(options.positionSigma), timeSigmaMs: Number(options.clockSigma), attitudeSigmaRad: Number(options.attitudeSigma) }
        if (Object.values(uncertainty).some(n => !Number.isFinite(n) || n < 0) || uncertainty.positionSigmaM > 10 || uncertainty.timeSigmaMs > 100 || uncertainty.attitudeSigmaRad > 0.1) throw new RangeError('Invalid declared survey uncertainty')
        const survey = reduceSurfaceSurvey(run.path, uncertainty)
        await writeFile(options.survey, `${JSON.stringify(survey, null, 2)}\n`)
        exportedSoundings = survey.soundings.length
      }
      print(JSON.stringify({ surveyFile: options.survey ?? null, exportedSoundings, vehicle: 'surface', scenario, status: run.status, fault: run.fault, mission: run.mission, authority: run.authority, board: run.board, recordedMissionRows: run.trace.rows.length, evaluatedPathRows: run.path.length, physicalValidation: false }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = ['nominal', 'harbour-return', 'current'].includes(scenario) ? 'completed' : scenario === 'host-loss' ? 'host-lost' : 'blocked'
      if (run.status !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
