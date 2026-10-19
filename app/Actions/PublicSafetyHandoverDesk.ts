import { Action } from '@stacksjs/actions'
import { readHandoverDeskHttp } from '../../resources/functions/drone/public-safety/access/handover-http'

export default new Action({
  name: 'PublicSafetyHandoverDesk', method: 'GET',
  handle: request => readHandoverDeskHttp(request),
})
