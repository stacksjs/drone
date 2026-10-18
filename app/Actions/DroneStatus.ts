import { Action } from '@stacksjs/actions'
import { defaultLimits } from '../../resources/functions/drone/safety'
import { driverProfiles } from '../../resources/functions/drone/drivers/profiles'

export default new Action({
  name: 'Drone capabilities',
  method: 'GET',
  handle() {
    return { physicalFlightEnabled: false, adapters: ['simulation', 'sitl', 'telemetry-only'], drivers: driverProfiles, nativeAutopilot: 'planned', cameraTracking: 'image-space', coordinateFrame: 'LOCAL_NED', limits: defaultLimits }
  },
})
