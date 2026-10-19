import { Action } from '@stacksjs/actions'
import { listObservationsHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetyObservationList', method: 'GET',
  handle: request => listObservationsHttp(request),
})
