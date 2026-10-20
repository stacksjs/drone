import { Middleware } from '@stacksjs/router'
import Auth from '../../storage/framework/defaults/app/Middleware/Auth'
import { isPatrolDatabaseBusy, PatrolReviewError } from '../../resources/functions/drone/navigation/review/contract'

/** Preserve the native Auth implementation and classify only the observed SQLite busy error. */
export default new Middleware({
  name: 'PatrolAuth',
  priority: 1,
  async handle(request) {
    try { await Auth.handle(request) }
    catch (error) {
      if (isPatrolDatabaseBusy(error)) throw new PatrolReviewError(503)
      throw error
    }
  },
})
