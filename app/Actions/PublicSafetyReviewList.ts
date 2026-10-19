import { Action } from '@stacksjs/actions'
import { listReviewsHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetyReviewList', method: 'GET',
  handle: request => listReviewsHttp(request),
})
