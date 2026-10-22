import type { Socket } from 'node:net'
import { createConnection } from 'node:net'
import type { AutopilotAdapter, AutopilotSessionOptions } from './drivers/session'
import { createAutopilotSession } from './drivers/session'
import { createMavlinkSigning } from './drivers/signing'
import { createMavlinkStreamDecoder } from './mavlink'

export interface TcpOptions extends AutopilotSessionOptions { port: number }

/** One explicit loopback connection. Reconnect by creating a new adapter and reconciling state. */
export async function createTcpAdapter(options: TcpOptions): Promise<AutopilotAdapter> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new RangeError('Invalid TCP port')
  const signing = options.signing ? createMavlinkSigning(options.signing) : undefined
  const decoder = createMavlinkStreamDecoder(signing)
  let socket: Socket | undefined, connected = false, closed = false, failed = false, blocked = false, matchedHeartbeat = false
  let timer: ReturnType<typeof setInterval> | undefined
  let blockedSince = 0, queuedBytes = 0, lastWriteProgress = 0
  const session = createAutopilotSession(options, signing, {
    available: () => connected && !closed && !failed,
    write(bytes) {
      if (!socket || !connected || closed || failed || blocked || Math.max(socket.writableLength, queuedBytes) + bytes.length > 16_384) {
        fail('TCP output unavailable or backpressured; remote outcome is uncertain'); throw new Error('TCP output unavailable or backpressured; remote outcome is uncertain')
      }
      if (queuedBytes === 0) lastWriteProgress = performance.now()
      queuedBytes += bytes.length
      // Bound outstanding write callbacks as well as the runtime's writableLength.
      // false means accepted by the stream. Never resend these bytes on drain.
      try {
        if (!socket.write(bytes, error => { queuedBytes -= bytes.length; lastWriteProgress = performance.now(); if (error) fail('TCP write failed; remote outcome is uncertain') })) { blocked = true; blockedSince = performance.now() }
      }
      catch (error) { fail('TCP write failed; remote outcome is uncertain'); throw error }
    },
  })
  function stopPolling() { if (timer) { clearInterval(timer); timer = undefined } }
  function fail(message = 'TCP connection closed') { if (!failed && !closed) { failed = true; connected = false; stopPolling(); decoder.reset(); session.transportLost(message); socket?.destroy() } }
  const transport = createConnection({ host: '127.0.0.1', port: options.port })
  socket = transport
  transport.setNoDelay(true)
  transport.on('error', () => fail('TCP socket error'))
  transport.on('end', () => fail())
  transport.on('close', () => fail())
  transport.on('drain', () => { blocked = false })
  transport.on('data', bytes => {
    if (closed || failed) return
    if (typeof bytes === 'string') { fail('TCP byte stream unexpectedly decoded as text'); return }
    try {
      for (let offset = 0; offset < bytes.length; offset += 65_536) {
        for (const frame of decoder.push(bytes.subarray(offset, offset + 65_536))) {
          if (!matchedHeartbeat && frame.id !== 0) continue
          if (session.receive(frame) && frame.id === 0) matchedHeartbeat = true
        }
      }
    }
    catch { fail('TCP input decoding failed') }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { fail('TCP connection deadline expired'); finish(new Error('TCP connection deadline expired')) }, 2000)
      function finish(error?: Error) {
        clearTimeout(timeout); transport.off('connect', ready); transport.off('error', rejected); transport.off('close', disconnected)
        if (error) reject(error); else resolve()
      }
      const ready = () => { connected = true; finish() }
      const rejected = (error: Error) => finish(error)
      const disconnected = () => finish(new Error('TCP connection closed before ready'))
      transport.once('connect', ready); transport.once('error', rejected); transport.once('close', disconnected)
    })
    if (failed || transport.destroyed || !connected) throw new Error('TCP connection unavailable')
  }
  catch (error) { session.close(); transport.destroy(); throw error }
  const heartbeatDeadline = performance.now() + 2000
  timer = setInterval(() => {
    if (!matchedHeartbeat && performance.now() >= heartbeatDeadline) fail('TCP matching heartbeat deadline expired')
    if (blocked && performance.now() - blockedSince >= 500) fail('TCP output drain deadline expired; remote outcome is uncertain')
    if (queuedBytes > 0 && performance.now() - lastWriteProgress >= 500) fail('TCP write progress deadline expired; remote outcome is uncertain')
    session.protocol.tick()
    if (session.protocol.snapshot().fault) fail()
  }, 25)
  timer.unref()
  return {
    kind: session.kind, driver: session.driver, read: session.read, protocol: session.protocol, localPort: transport.localPort!,
    send: session.send, primeOffboard: session.primeOffboard,
    close() { if (!closed) { closed = true; connected = false; stopPolling(); decoder.reset(); session.close(); transport.destroy() } },
  }
}
