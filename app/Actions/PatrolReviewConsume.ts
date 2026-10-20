import { Action } from '@stacksjs/actions'
import { consumePatrolReviewHttp } from '../../resources/functions/drone/navigation/review/http'
export default new Action({ name: 'PatrolReviewConsume', method: 'POST', handle: request => consumePatrolReviewHttp(request) })
