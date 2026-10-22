import { createSocket } from 'node:dgram'
import type { AutopilotAdapter, AutopilotSessionOptions } from './drivers/session'
import { createAutopilotSession } from './drivers/session'
import { createMavlinkSigning } from './drivers/signing'
import { decodeDatagram } from './mavlink'

export type { AutopilotAdapter } from './drivers/session'
export interface UdpOptions extends AutopilotSessionOptions {
  listenPort: number
  /** Fixed loopback destination. Never point a SITL forwarder at a physical vehicle. */
  sitlPort?: number
}

/** Local MAVProxy/mavlink-router endpoint. Physical hardware is receive-only. */
export async function createUdpAdapter(options: UdpOptions): Promise<AutopilotAdapter> {
  const portValid = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65535
  if (!(options.listenPort === 0 || portValid(options.listenPort)) || (options.sitlPort !== undefined && !portValid(options.sitlPort))) throw new RangeError('Invalid UDP port')
  const signing = options.signing ? createMavlinkSigning(options.signing) : undefined
  let peerPort = options.sitlPort, closed = false
  const socket = createSocket('udp4')
  const session = createAutopilotSession(options, signing, {
    available: () => !closed && peerPort !== undefined,
    write(bytes) { socket.send(bytes, peerPort!, '127.0.0.1', error => { if (error) session.transportLost() }) },
  })
  socket.on('error', () => session.transportLost())
  socket.on('message', (bytes, remote) => {
    if (remote.address !== '127.0.0.1' || (peerPort !== undefined && remote.port !== peerPort)) return
    for (const frame of decodeDatagram(bytes, signing)) {
      if (peerPort === undefined && frame.id !== 0) continue
      if (session.receive(frame) && frame.id === 0) peerPort ??= remote.port
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(options.listenPort, '127.0.0.1', () => { socket.off('error', reject); resolve() })
    })
  }
  catch (error) { session.close(); try { socket.close() } catch {} throw error }
  const timer = setInterval(() => session.protocol.tick(), 25)
  timer.unref()
  return {
    kind: session.kind, driver: session.driver, read: session.read, protocol: session.protocol, localPort: socket.address().port,
    send: session.send, primeOffboard: session.primeOffboard,
    close() { if (!closed) { closed = true; clearInterval(timer); session.close(); socket.close() } },
  }
}
