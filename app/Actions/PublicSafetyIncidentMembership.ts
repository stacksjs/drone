import { Action } from '@stacksjs/actions'
import { changeIncidentMembershipHttp } from '../../resources/functions/drone/public-safety/access/http'

export default new Action({
  name: 'PublicSafetyIncidentMembership', method: 'PUT',
  handle: request => changeIncidentMembershipHttp(request),
})
