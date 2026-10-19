import { Action } from '@stacksjs/actions'
import { readRetentionHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyRetentionRead', method: 'GET',
  handle: request => readRetentionHttp(request),
})
