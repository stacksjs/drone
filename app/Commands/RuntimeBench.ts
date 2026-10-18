import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { runRuntimeBench, runtimeBenchFaults, type RuntimeBenchFault } from '../../resources/functions/drone/runtime/bench'

export default defineCommand({
  name: 'runtime:bench',
  description: 'Exercise the native kernel and Pi protocol with a deterministic host HAL',
  options: {
    '--ticks <n>': { description: 'Virtual 1 kHz ticks, 1..100000', default: '1000' },
    '--fault <fault>': { description: 'none, deadline, stale, expiry, replay or version', default: 'none' },
    '--project <path>': 'Drone source checkout, defaults to the current directory',
  },
  async handle(options) {
    try {
      if (!runtimeBenchFaults.includes(options.fault as RuntimeBenchFault)) throw new Error('Unsupported runtime bench fault')
      print(JSON.stringify(await runRuntimeBench({ project: options.project, ticks: Number(options.ticks), fault: options.fault as RuntimeBenchFault }), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
