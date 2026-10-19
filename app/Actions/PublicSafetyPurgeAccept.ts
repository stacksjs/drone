import { Action } from '@stacksjs/actions'
import { acceptPurgeHttp } from '../../resources/functions/drone/public-safety/purge/http'

export default new Action({
  name: 'PublicSafetyPurgeAccept', method: 'POST',
  handle: request => acceptPurgeHttp(request),
})
