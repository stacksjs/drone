import { Action } from '@stacksjs/actions'
import { createManagedDatasetHttp } from '../../resources/functions/drone/public-safety/managed/http'

export default new Action({
  name: 'PublicSafetyManagedCreate', method: 'POST',
  handle: request => createManagedDatasetHttp(request),
})
