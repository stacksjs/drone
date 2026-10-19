import { Action } from '@stacksjs/actions'
import { readManagedArtifactFileHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedFile', method: 'GET',
  handle: request => readManagedArtifactFileHttp(request),
})
