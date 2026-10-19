import { Action } from '@stacksjs/actions'
import { registerSourceHttp } from '../../resources/functions/drone/public-safety/access/records-http'

export default new Action({
  name: 'PublicSafetySourceRegister', method: 'POST',
  handle: request => registerSourceHttp(request),
})
