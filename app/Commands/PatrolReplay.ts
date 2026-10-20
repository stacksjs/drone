import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { replayPatrolDataset } from '../../resources/functions/drone/navigation/recording'

export default defineCommand({
  name: 'patrol:replay <directory>',
  description: 'Rerun a completed unsigned fixed-model dataset and compare its compact summary',
  options: {
    '--unsigned-local-review': { description: 'Fresh opt-in for any retained local decisions', default: false },
    '--enable-charge': { description: 'Fresh opt-in for any retained modeled charge decision', default: false },
  },
  async handle(options, directory) {
    try {
      const { unsignedLocalReview, enableCharge } = options
      if (typeof directory !== 'string' || typeof unsignedLocalReview !== 'boolean' || typeof enableCharge !== 'boolean' || enableCharge && !unsignedLocalReview) throw new TypeError('Invalid patrol replay options')
      const result = await replayPatrolDataset(directory, { unsignedLocalReview, enableCharge })
      if (result.summary.status === 'failed') process.exitCode = 1
      await printAsync(JSON.stringify(result))
    }
    catch {
      process.exitCode = 1
      await printErrorAsync('Patrol replay failed: invalid input, unavailable result or output failure')
    }
  },
})
