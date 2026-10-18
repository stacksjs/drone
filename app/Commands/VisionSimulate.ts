import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { VisionScenario } from '../../resources/functions/drone/vision/simulation'
import { simulateVision, visionScenarios } from '../../resources/functions/drone/vision/simulation'

export default defineCommand({
  name: 'vision:simulate',
  description: 'Exercise explicit visual/GNSS pairing and registered-depth follow on the owned runtime',
  options: {
    '--scenario <name>': { description: visionScenarios.join(', '), default: 'follow' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..30 integer seconds', default: '20' },
  },
  handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds)) throw new RangeError('Vision seconds must be an integer from 8..30')
      const { path, ...result } = simulateVision({ scenario: options.scenario as VisionScenario, seconds: Number(options.seconds) })
      // eslint-disable-next-line
      print(JSON.stringify({ ...result, recordedRows: path.length }, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = options.scenario === 'follow' ? 'completed' : 'blocked'
      if (result.status !== expected || (options.scenario !== 'follow' && result.fusion.state !== 'lost')) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
