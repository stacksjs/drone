import { Action } from '@stacksjs/actions'
import { defaultLimits } from '../../resources/functions/drone/safety'

export default new Action({
  name: 'Drone capabilities',
  method: 'GET',
  handle() {
    return { physicalFlightEnabled: false, adapters: ['simulation', 'sitl', 'telemetry-only'], coordinateFrame: 'LOCAL_NED', limits: defaultLimits }
  },
})
