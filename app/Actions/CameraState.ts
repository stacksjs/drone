import { Action } from '@stacksjs/actions'
import { cameraState } from '../../resources/functions/drone/camera/http'

export default new Action({ name: 'Read camera tracking', method: 'GET', handle: request => cameraState(request) })
