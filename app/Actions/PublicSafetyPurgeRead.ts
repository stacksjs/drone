import { Action } from '@stacksjs/actions'
import { readPurgeHttp } from '../../resources/functions/drone/public-safety/purge/http'

export default new Action({
  name: 'PublicSafetyPurgeRead', method: 'GET',
  handle: request => readPurgeHttp(request),
})
