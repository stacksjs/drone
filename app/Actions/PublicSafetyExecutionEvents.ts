import { Action } from '@stacksjs/actions'
import { streamExecutionHttp } from '../../resources/functions/drone/public-safety/execution/http'

export default new Action({ name: 'PublicSafetyExecutionEvents', method: 'GET', handle: request => streamExecutionHttp(request) })
