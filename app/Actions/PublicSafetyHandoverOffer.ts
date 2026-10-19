import { Action } from '@stacksjs/actions'
import { offerHandoverHttp } from '../../resources/functions/drone/public-safety/access/handover-http'

export default new Action({
  name: 'PublicSafetyHandoverOffer', method: 'POST',
  handle: request => offerHandoverHttp(request),
})
