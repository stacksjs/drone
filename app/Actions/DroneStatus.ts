import { Action } from '@stacksjs/actions'
import { defaultLimits } from '../../resources/functions/drone/safety'
import { driverProfiles } from '../../resources/functions/drone/drivers/profiles'

export default new Action({
  name: 'Drone capabilities',
  method: 'GET',
  handle() {
    return { physicalFlightEnabled: false, adapters: ['simulation', 'sitl', 'telemetry-only'], drivers: driverProfiles, driverProtocols: 'shared MAVLink 2 ACK, parameter and waypoint services with optional signing, scripted UDP conformance only', nativeAutopilot: 'planned', nativeRuntime: 'neutral-only bench kernel, hardware unvalidated', sensors: 'native bench acquisition, calibrated diagnostic replay, hardware unvalidated', estimation: 'owned replayable tilt and GNSS local-position bench estimator, absolute heading unavailable', controls: 'owned quad-X, fixed-wing, differential-ground and planar-surface physics with estimator feedback, physical outputs inhibited', missions: 'owned v1 quad and explicit v2 vehicle graphs, replay, recovery and scoped modeled payload ACKs', vehicleEvidence: 'owned physics simulation only; native board, HIL and physical validation pending', authority: 'versioned simulation supervisor and modeled output watchdog, physical authority unavailable', cameraTracking: 'image-space', coordinateFrame: 'LOCAL_NED', limits: defaultLimits }
  },
})
