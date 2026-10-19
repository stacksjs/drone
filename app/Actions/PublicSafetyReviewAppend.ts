import { Action } from '@stacksjs/actions'
import { appendReviewHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetyReviewAppend', method: 'POST',
  handle: request => appendReviewHttp(request),
})
