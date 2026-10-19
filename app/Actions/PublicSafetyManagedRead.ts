import { Action } from '@stacksjs/actions'
import { readManagedArtifactHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedRead', method: 'GET',
  handle: request => readManagedArtifactHttp(request),
})
