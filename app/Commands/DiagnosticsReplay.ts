import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseDiagnosticsJournal } from '../../resources/functions/drone/diagnostics/journal'
import { readDiagnosticsFile } from '../../resources/functions/drone/diagnostics/files'
import { createDiagnosticsReplay } from '../../resources/functions/drone/diagnostics/replay'
export default defineCommand({
  name: 'diagnostics:replay <path>',
  description: 'Verify and replay a bounded diagnostic journal without a vehicle connection',
  options: { '--at-ms <n>': 'Replay offset in milliseconds; defaults to the last recorded epoch' },
  async handle(options, path) {
    try {
      const journal = await parseDiagnosticsJournal(await readDiagnosticsFile(path))
      print(JSON.stringify(createDiagnosticsReplay(journal).advanceTo(options.atMs === undefined ? journal.footer?.atMs ?? journal.events.at(-1)?.atMs ?? 0 : Number(options.atMs)), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
