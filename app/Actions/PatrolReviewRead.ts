import { Action } from '@stacksjs/actions'
import { readPatrolReviewHttp } from '../../resources/functions/drone/navigation/review/http'
export default new Action({ name: 'PatrolReviewRead', method: 'GET', handle: request => readPatrolReviewHttp(request) })
