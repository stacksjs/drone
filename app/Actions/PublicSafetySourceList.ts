import { Action } from '@stacksjs/actions'
import { listSourcesHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetySourceList', method: 'GET',
  handle: request => listSourcesHttp(request),
})
