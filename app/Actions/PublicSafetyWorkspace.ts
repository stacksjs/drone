import { Action } from '@stacksjs/actions'
import { readWorkspaceHttp } from '../../resources/functions/drone/public-safety/workspace/http'

export default new Action({ name: 'PublicSafetyWorkspace', method: 'GET', handle: request => readWorkspaceHttp(request) })
