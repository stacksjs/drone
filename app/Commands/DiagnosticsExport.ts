import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { exportDiagnostics } from '../../resources/functions/drone/diagnostics/files'
export default defineCommand({
  name: 'diagnostics:export <path>',
  description: 'Export schema-verified diagnostic records to a new private local directory',
  options: { '--output <directory>': 'Required new export directory' },
  async handle(options, path) {
    try {
      if (!options.output) throw new TypeError('Supply --output with a new directory')
      print(JSON.stringify(await exportDiagnostics(path, options.output), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
