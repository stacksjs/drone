import { Action } from '@stacksjs/actions'
import { admitExecutionHttp } from '../../resources/functions/drone/public-safety/execution/http'

export default new Action({ name: 'PublicSafetyExecutionAdmission', method: 'POST', handle: request => admitExecutionHttp(request) })
