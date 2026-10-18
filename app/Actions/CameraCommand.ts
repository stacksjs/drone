import { Action } from '@stacksjs/actions'
import { cameraCommand } from '../../resources/functions/drone/camera/http'

export default new Action({
  name: 'Camera operator command', method: 'POST',
  // This API accepts an explicit bearer token only, never cookie/session authority.
  skipCsrf: true,
  handle: request => cameraCommand(request),
})
