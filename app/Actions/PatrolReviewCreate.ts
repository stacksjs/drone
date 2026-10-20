import { Action } from '@stacksjs/actions'
import { createPatrolReviewHttp } from '../../resources/functions/drone/navigation/review/http'
export default new Action({ name: 'PatrolReviewCreate', method: 'POST', handle: request => createPatrolReviewHttp(request) })
