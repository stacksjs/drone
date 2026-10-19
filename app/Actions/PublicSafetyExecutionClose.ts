import { Action } from '@stacksjs/actions'
import { closeExecutionHttp } from '../../resources/functions/drone/public-safety/execution/http'

export default new Action({ name: 'PublicSafetyExecutionClose', method: 'POST', handle: request => closeExecutionHttp(request) })
