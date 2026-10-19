import { Action } from '@stacksjs/actions'
import { readIncidentHttp } from '../../resources/functions/drone/public-safety/access/http'

export default new Action({
  name: 'PublicSafetyIncidentRead', method: 'GET',
  handle: request => readIncidentHttp(request),
})
