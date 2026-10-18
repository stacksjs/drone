import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { InspectionScenario } from '../../resources/functions/drone/inspection/types'
import { inspectionScenarios, simulateInspection } from '../../resources/functions/drone/inspection/runtime'
import { writeInspectionDataset } from '../../resources/functions/drone/inspection/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'inspection:simulate',
  description: 'Collect synthetic bridge-face visible and thermal evidence through the owned vehicle runtime',
  options: {
    '--config <path>': 'Optional bounded inspection configuration JSON',
    '--scenario <name>': { description: inspectionScenarios.join(', '), default: 'nominal' },
    '--visit <id>': { description: 'Explicit recording visit identity', default: 'visit-one' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..120 integer seconds', default: '100' },
    '--output <directory>': 'New private image, thermal, recording and review dataset',
  },
  async handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds)) throw new RangeError('Inspection seconds must be an integer from 8..120')
      let config: unknown
      if (options.config) {
        try { config = JSON.parse(await readMissionFile(options.config)) }
        catch { throw new TypeError('Invalid inspection configuration JSON or file') }
      }
      const run = simulateInspection({ config, scenario: options.scenario as InspectionScenario, seconds: Number(options.seconds), visitId: options.visit })
      const dataset = options.output ? await writeInspectionDataset(options.output, run) : null
      print(JSON.stringify({ status: run.status, reason: run.reason, visitId: run.visitId, evidence: run.evidence, physicalFlightEnabled: false, physicalInspectionVerified: false, boardNeutral: run.boardNeutral, captures: run.captures.length, qualifiedCaptures: run.captures.filter(c => c.quality.qualified).length, minimumObservedSeparationM: run.minimumObservedSeparationM, dataset }, null, 2))
      const expected = ['nominal', 'wind', 'pause-resume'].includes(options.scenario) ? 'completed' : ['gnss-loss', 'rc-override'].includes(options.scenario) ? 'blocked' : 'aborted'
      if (run.status !== expected || !run.boardNeutral) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
