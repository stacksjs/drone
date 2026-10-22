import type { UdpOptions } from '../udp'
import { createUdpAdapter } from '../udp'
import type { TcpAdapter, TcpOptions } from '../tcp'
import { createTcpAdapter } from '../tcp'
import type { AutopilotAdapter } from './session'

export type TcpDriverOptions = Omit<TcpOptions, 'driver'> & { transport: 'tcp' }
export type AutopilotDriverOptions = (Omit<UdpOptions, 'driver'> & { transport?: 'udp' }) | TcpDriverOptions
function createDriver(driver: 'ardupilot' | 'px4', options: AutopilotDriverOptions) {
  if (options.transport === 'tcp') return createTcpAdapter({ ...options, driver })
  if (options.transport !== undefined && options.transport !== 'udp') throw new TypeError('Unknown autopilot transport')
  return createUdpAdapter({ ...options, driver })
}

/** Explicit factories prevent guessing an autopilot from whichever packet arrives first. */
export function createArduPilotDriver(options: TcpDriverOptions): Promise<TcpAdapter>
export function createArduPilotDriver(options: AutopilotDriverOptions): Promise<AutopilotAdapter>
export function createArduPilotDriver(options: AutopilotDriverOptions) { return createDriver('ardupilot', options) }
export function createPx4Driver(options: TcpDriverOptions): Promise<TcpAdapter>
export function createPx4Driver(options: AutopilotDriverOptions): Promise<AutopilotAdapter>
export function createPx4Driver(options: AutopilotDriverOptions) { return createDriver('px4', options) }

export type { TcpAdapter, TcpTransportSnapshot } from '../tcp'

export type { AutopilotProtocol, DriverOperationOptions, CommandAcknowledgement, DriverProtocolError } from './protocol'
export type { DriverCapabilities, DriverParameter, MissionWaypoint, ParameterType } from './messages'
