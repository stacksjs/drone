import type { Telemetry } from '../types'

export type AutopilotDriverId = 'ardupilot' | 'px4'
export const driverProfiles = Object.freeze({
  ardupilot: Object.freeze({ id: 'ardupilot', autopilotId: 3, vehicleType: 2, externalMode: 'Guided', offboardPriming: false, physicalCommands: false }),
  px4: Object.freeze({ id: 'px4', autopilotId: 12, vehicleType: 2, externalMode: 'Offboard', offboardPriming: true, physicalCommands: false }),
})

/** 'guided' is the existing library's external-velocity authority mode. */
export function decodeAutopilotMode(driver: AutopilotDriverId, customMode: number): Telemetry['mode'] {
  if (driver === 'ardupilot') return customMode === 4 ? 'guided' : customMode === 6 ? 'rtl' : customMode === 9 ? 'land' : 'manual'
  const main = (customMode >>> 16) & 0xFF
  const sub = (customMode >>> 24) & 0xFF
  return main === 6 ? 'guided' : main === 4 && sub === 5 ? 'rtl' : main === 4 && sub === 6 ? 'land' : 'manual'
}
