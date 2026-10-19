import { Action } from '@stacksjs/actions'
import { listManagedArtifactsHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedList', method: 'GET',
  handle: request => listManagedArtifactsHttp(request),
})
