import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { readMissionFile } from '../../resources/functions/drone/missions/files'
import { parseVisionProfile } from '../../resources/functions/drone/vision/profile'

export default defineCommand({
  name: 'vision:validate <path>',
  description: 'Check lens, crop, extrinsics and independent held-out 3D correspondences',
  // eslint-disable-next-line
  async handle(options, path) {
    try { print(JSON.stringify(parseVisionProfile(await readMissionFile(path)).report, null, 2)) }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
