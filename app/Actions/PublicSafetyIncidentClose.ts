import { Action } from '@stacksjs/actions'
import { closeIncidentHttp } from '../../resources/functions/drone/public-safety/access/http'

export default new Action({
  name: 'PublicSafetyIncidentClose', method: 'POST',
  handle: request => closeIncidentHttp(request),
})
