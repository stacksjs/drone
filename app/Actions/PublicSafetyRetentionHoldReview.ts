import { Action } from '@stacksjs/actions'
import { reviewRetentionHoldHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyRetentionHoldReview', method: 'POST',
  handle: request => reviewRetentionHoldHttp(request),
})
