import { Action } from '@stacksjs/actions'
import { previewPurgeHttp } from '../../resources/functions/drone/public-safety/purge/http'

export default new Action({
  name: 'PublicSafetyPurgePreview', method: 'GET',
  handle: request => previewPurgeHttp(request),
})
