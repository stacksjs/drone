import { Action } from '@stacksjs/actions'
import { listPurgeEventsHttp } from '../../resources/functions/drone/public-safety/purge/http'

export default new Action({
  name: 'PublicSafetyPurgeEvents', method: 'GET',
  handle: request => listPurgeEventsHttp(request),
})
