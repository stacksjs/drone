import { Action } from '@stacksjs/actions'
import { auditIncidentHttp } from '../../resources/functions/drone/public-safety/access/http'

export default new Action({
  name: 'PublicSafetyIncidentAudit', method: 'GET',
  handle: request => auditIncidentHttp(request),
})
