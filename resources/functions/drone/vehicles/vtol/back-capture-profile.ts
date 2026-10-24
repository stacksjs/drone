import type { VehicleProfile } from '../types'
import { createVtolTransitionProfile } from './transition-profile'

/** Explicit fictional example: retain cruise, then approach a declared 330 m hover anchor. */
export function createVtolBackCaptureProfile(): VehicleProfile {
  const profile = createVtolTransitionProfile({ electrical: true })
  profile.positionPrediction = 'fixture-imu'
  profile.name = 'Owned VTOL bounded back-capture development'
  profile.mission.id = 'vtol-planned-back-capture'
  const back = profile.mission.tasks.find(task => task.id === 'back')
  const land = profile.mission.tasks.find(task => task.id === 'land')
  if (!back || back.kind !== 'vtol-mode' || !land || land.kind !== 'land') throw new TypeError('Missing VTOL example capture tasks')
  back.anchorM = [330, 0, -15]
  back.approach = 'bounded-approach-v1'
  land.positionM = [330, 0, 0]
  return profile
}
