import type { Socket } from 'node:net'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import type { MavlinkFrame } from '../mavlink'
import { createMavlinkStreamDecoder, decodeDatagram } from '../mavlink'
import type { MavlinkSigning } from './signing'

/** Owned scripted peer only. No forwarding, credentials or external firmware. */
export async function createDriverBenchPeer(transport: 'udp' | 'tcp', signing: MavlinkSigning | undefined, receive: (frames: MavlinkFrame[]) => void, onError: (error: Error) => void) {
  let clientPort: number | null = null
  if (transport === 'udp') {
    const socket = createSocket('udp4')
    socket.on('error', onError)
    socket.on('message', (bytes, remote) => { if (remote.address === '127.0.0.1' && remote.port === clientPort) receive(decodeDatagram(bytes, signing)) })
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', () => { socket.off('error', reject); resolve() }) })
    return { port: socket.address().port, start(port: number) { clientPort = port }, send(bytes: Uint8Array) { if (clientPort !== null) socket.send(bytes, clientPort, '127.0.0.1') }, async close() { await new Promise<void>(resolve => socket.close(() => resolve())) } }
  }
  let connection: Socket | null = null
  const server = createServer(socket => {
    if (connection) { socket.destroy(); return }
    connection = socket
    const decoder = createMavlinkStreamDecoder(signing)
    socket.on('error', onError)
    socket.on('data', bytes => {
      if (typeof bytes === 'string') { onError(new Error('Scripted TCP byte stream unexpectedly decoded as text')); socket.destroy(); return }
      try { for (let at = 0; at < bytes.length; at += 65_536) receive(decoder.push(bytes.subarray(at, at + 65_536))) }
      catch (error) { onError(error instanceof Error ? error : new Error(String(error))); socket.destroy() }
    })
  })
  server.on('error', onError)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing scripted TCP peer port')
  return {
    port: address.port,
    start(port: number) { clientPort = port },
    send(bytes: Uint8Array) {
      if (!connection || connection.remotePort !== clientPort) return
      if (connection.writableLength + bytes.length > 16_384) { onError(new Error('Scripted TCP peer exceeded output bound')); connection.destroy(); return }
      connection.write(bytes)
    },
    async close() { connection?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
