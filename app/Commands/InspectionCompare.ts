import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { compareInspectionVisits, parseInspectionRecording } from '../../resources/functions/drone/inspection/evidence'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'inspection:compare <before> <after>',
  description: 'Compare asset/station capture geometry between explicit visits without diagnosing deterioration',
  // eslint-disable-next-line
  async handle(options, before, after) {
    try {
      const first = parseInspectionRecording(await readMissionFile(before))
      const second = parseInspectionRecording(await readMissionFile(after))
      print(JSON.stringify(compareInspectionVisits(first, second), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
