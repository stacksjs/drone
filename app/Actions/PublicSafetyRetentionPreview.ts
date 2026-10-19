import { Action } from '@stacksjs/actions'
import { previewRetentionHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyRetentionPreview', method: 'GET',
  handle: request => previewRetentionHttp(request),
})
