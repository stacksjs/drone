import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { RuntimeBenchFault } from '../../resources/functions/drone/runtime/bench'
import { recordRuntimeDiagnostics } from '../../resources/functions/drone/diagnostics/bench'
export default defineCommand({
  name: 'diagnostics:record',
  description: 'Record a native host runtime bench into a bounded private diagnostic journal',
  options: {
    '--output <directory>': 'Required new output directory; parent must exist',
    '--project <path>': 'Source checkout containing the native runtime',
    '--ticks <n>': { description: 'Virtual runtime ticks, 1..100000', default: '1000' },
    '--fault <name>': { description: 'none, deadline, stale, expiry, replay or version', default: 'deadline' },
  },
  async handle(options) {
    try {
      if (!options.output) throw new TypeError('Supply --output with a new directory')
      print(JSON.stringify(await recordRuntimeDiagnostics({ directory: options.output, project: options.project, ticks: Number(options.ticks), fault: options.fault as RuntimeBenchFault }), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
