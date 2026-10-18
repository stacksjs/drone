import type { GeodeticOrigin } from '../estimation/frames'
import { geodeticToNed } from '../estimation/frames'

export interface AntennaPointing {
  azimuthDeg: number
  elevationDeg: number
  rangeM: number
  nedM: [number, number, number]
  enuM: [number, number, number]
}
/** True geodetic north, clockwise azimuth; reuse the owned fixed WGS84 NED transform. */
export function antennaPointing(origin: GeodeticOrigin, target: GeodeticOrigin): AntennaPointing {
  const nedM = geodeticToNed(target, origin)
  const [north, east, down] = nedM
  const horizontal = Math.hypot(north, east), rangeM = Math.hypot(horizontal, down)
  if (rangeM < 1 || horizontal < 0.1) throw new RangeError('Antenna line of sight is coincident or azimuth is singular')
  return { azimuthDeg: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360, elevationDeg: Math.atan2(-down, horizontal) * 180 / Math.PI, rangeM, nedM, enuM: [east, north, -down] }
}

/** Continuous mechanical angle nearest the current pan. Never silently unwind a cable. */
export function unwrapPan(angleDeg: number, currentPanDeg: number): number {
  if (![angleDeg, currentPanDeg].every(Number.isFinite)) throw new RangeError('Invalid pan angle')
  return currentPanDeg + ((angleDeg - currentPanDeg) % 360 + 540) % 360 - 180
}
