import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { ControlScenario } from '../../resources/functions/drone/controls/simulation'
import { controlScenarios, simulateMultirotor } from '../../resources/functions/drone/controls/simulation'
export default defineCommand({
  name: 'controls:simulate',
  description: 'Run the owned estimator and multirotor controller in a bounded rigid-body simulation',
  options: {
    '--scenario <name>': { description: 'hover, step, wind, delay or imu-loss', default: 'step' },
    '--seconds <n>': { description: 'Integer virtual duration, 2..60 seconds', default: '20' },
    '--sensor-delay-ms <ms>': 'Additional modeled sensor latency, 0..200 ms',
  },
  handle(options) {
    try {
      if (!controlScenarios.includes(options.scenario as ControlScenario)) throw new RangeError('Unknown control scenario')
      const result = simulateMultirotor({ scenario: options.scenario as ControlScenario, seconds: Number(options.seconds), sensorDelayMs: options.sensorDelayMs === undefined ? undefined : Number(options.sensorDelayMs) })
      // eslint-disable-next-line
      print(JSON.stringify(result, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
