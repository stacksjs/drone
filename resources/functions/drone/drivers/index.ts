import type { UdpOptions } from '../udp'
import { createUdpAdapter } from '../udp'

/** Explicit factories prevent guessing an autopilot from whichever packet arrives first. */
export const createArduPilotDriver = (options: Omit<UdpOptions, 'driver'>) => createUdpAdapter({ ...options, driver: 'ardupilot' })
export const createPx4Driver = (options: Omit<UdpOptions, 'driver'>) => createUdpAdapter({ ...options, driver: 'px4' })
