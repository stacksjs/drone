import { Action } from '@stacksjs/actions'
import { reconcileManagedArtifactHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedReconcile', method: 'POST',
  handle: request => reconcileManagedArtifactHttp(request),
})
