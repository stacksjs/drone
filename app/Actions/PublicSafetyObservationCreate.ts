import { Action } from '@stacksjs/actions'
import { appendObservationHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetyObservationCreate', method: 'POST',
  handle: request => appendObservationHttp(request),
})
