import { Action } from '@stacksjs/actions'
import { enrollRetentionHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyRetentionEnroll', method: 'POST',
  handle: request => enrollRetentionHttp(request),
})
