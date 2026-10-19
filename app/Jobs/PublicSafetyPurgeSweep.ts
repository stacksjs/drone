import { Job } from '@stacksjs/queue'
import { runPublicSafetyPurgeBatch } from '../../resources/functions/drone/public-safety/purge/executor'
import { PublicSafetyAccessError } from '../../resources/functions/drone/public-safety/access/errors'
import { requirePurgeEnabled } from '../../resources/functions/drone/public-safety/purge/policy'

/** No rate or Scheduler registration. Direct and named dispatch enforce opt-in inside handle. */
export default new Job({
  name: 'PublicSafetyPurgeSweep', description: 'Advance explicitly accepted local incident purges',
  enabled: false, tries: 1,
  async handle(payload?: { purgeKey?: string }) {
    requirePurgeEnabled()
    try { await runPublicSafetyPurgeBatch(payload?.purgeKey ? { purgeKey: payload.purgeKey } : {}) }
    catch { throw new PublicSafetyAccessError(409, 'Local purge execution requires reconciliation') }
  },
})
