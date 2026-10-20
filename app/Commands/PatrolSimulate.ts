import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { readMissionFile } from '../../resources/functions/drone/missions/files'
import { simulatePatrol } from '../../resources/functions/drone/navigation/patrol'

export default defineCommand({
  name: 'patrol:simulate',
  description: 'Preview a finite owned patrol model with optional explicit unsigned local decisions',
  options: {
    '--profile <name>': { description: 'Closed modeled profile: nominal', default: 'nominal' },
    '--decisions <path>': { description: 'Regular local JSON decision file, at most 8192 bytes' },
    '--unsigned-local-review': { description: 'Explicitly opt in to unsigned local decision metadata', default: false },
    '--enable-charge': { description: 'Permit separately supplied modeled charge decisions', default: false },
  },
  async handle(options) {
    try {
      const { profile, decisions: path, unsignedLocalReview, enableCharge } = options
      if (profile !== 'nominal' || typeof unsignedLocalReview !== 'boolean' || typeof enableCharge !== 'boolean' || (path !== undefined && (typeof path !== 'string' || !path.length)) || (path !== undefined) !== unsignedLocalReview || enableCharge && !unsignedLocalReview) throw new TypeError('Invalid patrol options')
      let decisions: unknown = []
      if (path !== undefined) {
        const file: unknown = JSON.parse(await readMissionFile(path, { maxBytes: 8192, preserveBom: true }))
        if (!file || typeof file !== 'object' || Object.getPrototypeOf(file) !== Object.prototype) throw new TypeError('Invalid patrol file')
        const d = Object.getOwnPropertyDescriptors(file)
        if (Reflect.ownKeys(d).length !== 3 || ['version', 'profile', 'decisions'].some(k => !d[k]?.enumerable || !('value' in d[k]!)) || d.version!.value !== 1 || d.profile!.value !== profile) throw new TypeError('Invalid patrol file')
        decisions = d.decisions!.value
      }
      const result = simulatePatrol({ profile, unsignedLocalReview, enableCharge, decisions })
      if (result.status === 'failed') process.exitCode = 1
      await printAsync(JSON.stringify(result))
    }
    catch {
      process.exitCode = 1
      await printErrorAsync('Patrol simulation failed: invalid input, unavailable result or output failure')
    }
  },
})
