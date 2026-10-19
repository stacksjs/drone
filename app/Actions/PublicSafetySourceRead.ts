import { Action } from '@stacksjs/actions'
import { readSourceHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetySourceRead', method: 'GET',
  handle: request => readSourceHttp(request),
})
