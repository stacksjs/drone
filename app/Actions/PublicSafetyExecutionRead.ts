import { Action } from '@stacksjs/actions'
import { readExecutionHttp } from '../../resources/functions/drone/public-safety/execution/http'

export default new Action({ name: 'PublicSafetyExecutionRead', method: 'GET', handle: request => readExecutionHttp(request) })
