import { Action } from '@stacksjs/actions'
import { decidePatrolReviewHttp } from '../../resources/functions/drone/navigation/review/http'
export default new Action({ name: 'PatrolReviewDecide', method: 'POST', handle: request => decidePatrolReviewHttp(request) })
