import { Action } from '@stacksjs/actions'
import { retryPurgeHttp } from '../../resources/functions/drone/public-safety/purge/http'

export default new Action({
  name: 'PublicSafetyPurgeRetry', method: 'POST',
  handle: request => retryPurgeHttp(request),
})
