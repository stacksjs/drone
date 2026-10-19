import { Action } from '@stacksjs/actions'
import { streamWorkspaceHttp } from '../../resources/functions/drone/public-safety/workspace/http'

export default new Action({ name: 'PublicSafetyWorkspaceEvents', method: 'GET', handle: request => streamWorkspaceHttp(request) })
