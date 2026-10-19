import { Action } from '@stacksjs/actions'
import { createIncidentHttp } from '../../resources/functions/drone/public-safety/access/http'

export default new Action({
  name: 'PublicSafetyIncidentCreate', method: 'POST',
  handle: request => createIncidentHttp(request),
})
