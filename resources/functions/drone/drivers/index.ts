import type { UdpOptions } from '../udp'
import { createUdpAdapter } from '../udp'
import type { TcpOptions } from '../tcp'
import { createTcpAdapter } from '../tcp'

export type AutopilotDriverOptions = (Omit<UdpOptions, 'driver'> & { transport?: 'udp' }) | (Omit<TcpOptions, 'driver'> & { transport: 'tcp' })
function createDriver(driver: 'ardupilot' | 'px4', options: AutopilotDriverOptions) {
  if (options.transport === 'tcp') return createTcpAdapter({ ...options, driver })
  if (options.transport !== undefined && options.transport !== 'udp') throw new TypeError('Unknown autopilot transport')
  return createUdpAdapter({ ...options, driver })
}

/** Explicit factories prevent guessing an autopilot from whichever packet arrives first. */
export const createArduPilotDriver = (options: AutopilotDriverOptions) => createDriver('ardupilot', options)
export const createPx4Driver = (options: AutopilotDriverOptions) => createDriver('px4', options)

export type { AutopilotProtocol, DriverOperationOptions, CommandAcknowledgement, DriverProtocolError } from './protocol'
export type { DriverCapabilities, DriverParameter, MissionWaypoint, ParameterType } from './messages'
