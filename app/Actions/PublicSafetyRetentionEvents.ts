import { Action } from '@stacksjs/actions'
import { listRetentionEventsHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyRetentionEvents', method: 'GET',
  handle: request => listRetentionEventsHttp(request),
})
