import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseDiagnosticsJournal } from '../../resources/functions/drone/diagnostics/journal'
import { readDiagnosticsFile } from '../../resources/functions/drone/diagnostics/files'
import { diagnoseDiagnostics } from '../../resources/functions/drone/diagnostics/replay'
export default defineCommand({
  name: 'diagnostics:inspect <path>',
  description: 'Inspect provenance, loss, health and commissioning blockers in a verified journal',
  options: { '--check': 'Exit nonzero if recorded diagnostics fail; this never approves hardware commissioning' },
  async handle(options, path) {
    try {
      const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(path)), result = diagnoseDiagnostics(journal)
      print(JSON.stringify({ ...result, provenance: journal.header.provenance }, null, 2))
      if (options.check && result.diagnosticFailures) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
