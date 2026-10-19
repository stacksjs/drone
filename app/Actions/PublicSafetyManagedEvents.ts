import { Action } from '@stacksjs/actions'
import { listManagedArtifactEventsHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedEvents', method: 'GET',
  handle: request => listManagedArtifactEventsHttp(request),
})
