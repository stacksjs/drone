import { Action } from '@stacksjs/actions'
import { revokeCustodyMemberHttp } from '../../resources/functions/drone/public-safety/retention/http'

export default new Action({
  name: 'PublicSafetyCustodyMemberRevoke', method: 'POST',
  handle: request => revokeCustodyMemberHttp(request),
})
