import { Action } from '@stacksjs/actions'
import { readObservationHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetyObservationRead', method: 'GET',
  handle: request => readObservationHttp(request),
})
