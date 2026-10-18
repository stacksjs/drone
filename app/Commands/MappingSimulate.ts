import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { SurveyScenario } from '../../resources/functions/drone/mapping/runtime'
import { simulateSurvey, surveyScenarios } from '../../resources/functions/drone/mapping/runtime'
import { surveyQuality } from '../../resources/functions/drone/mapping/quality'
import { writeSurveyDataset } from '../../resources/functions/drone/mapping/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'mapping:simulate',
  description: 'Collect capture-bound synthetic survey images through the owned mission runtime',
  options: {
    '--scenario <name>': { description: surveyScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..120 integer seconds', default: '100' },
    '--config <path>': 'Optional bounded survey JSON',
    '--output <directory>': 'New private ODM input directory; reconstruction is separate',
  },
  async handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds)) throw new RangeError('Survey seconds must be an integer from 8..120')
      let config: unknown
      if (options.config) {
        try { config = JSON.parse(await readMissionFile(options.config)) }
        catch { throw new TypeError('Invalid survey configuration JSON or file') }
      }
      const run = simulateSurvey({ scenario: options.scenario as SurveyScenario, seconds: Number(options.seconds), config })
      const dataset = options.output ? await writeSurveyDataset(options.output, run) : null
      print(JSON.stringify({ status: run.status, reason: run.reason, evidence: run.evidence, physicalFlightEnabled: run.physicalFlightEnabled, boardNeutral: run.boardNeutral, captures: run.captures.length, quality: surveyQuality(run), dataset }, null, 2))
      const expected = ['nominal', 'crosshatch', 'terrain'].includes(options.scenario) ? 'completed' : ['rc-override', 'position-loss', 'imu-loss'].includes(options.scenario) ? 'blocked' : 'aborted'
      if (run.status !== expected || !run.boardNeutral) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
