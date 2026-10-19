import { Action } from '@stacksjs/actions'
import { decideHandoverHttp } from '../../resources/functions/drone/public-safety/access/handover-http'

export default new Action({
  name: 'PublicSafetyHandoverDecision', method: 'POST',
  handle: request => decideHandoverHttp(request),
})
