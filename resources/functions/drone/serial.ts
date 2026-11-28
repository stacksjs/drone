import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import type { AutopilotSessionOptions } from './drivers/session'
import type { AutopilotDriverId } from './drivers/profiles'
import type { Telemetry } from './types'
import { createAutopilotSession } from './drivers/session'
import { createMavlinkSigning } from './drivers/signing'
import { driverProfiles } from './drivers/profiles'
import { createMavlinkStreamDecoder } from './mavlink'

export const telemetrySerialRates = [57600, 115200, 230400, 460800, 921600] as const

export interface SerialTelemetryOptions extends Omit<AutopilotSessionOptions, 'kind' | 'driver'> {
  device: string
  driver: AutopilotDriverId
  baud?: number
}

export interface SerialTelemetryReader {
  readonly device: string
  read(): Telemetry | undefined
  close(): void
}

function terminalSettings(fd: number, args: string[]): string {
  const settings = spawnSync('/usr/bin/stty', args, { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096 })
  if (settings.error || settings.status !== 0) throw new Error('Serial port settings unavailable', { cause: settings.error })
  return settings.stdout.trim()
}

/** Linux byte stream opened read-only. A lost device ends this session, even if its path reappears. */
export function openSerialTelemetry(options: SerialTelemetryOptions): SerialTelemetryReader {
  if (process.platform !== 'linux') throw new Error('Direct serial telemetry requires Linux')
  const { device, driver, signing: signingOptions, systemId = 1, componentId = 1, now, baud = 115200 } = options
  if (!telemetrySerialRates.some(rate => rate === baud)) throw new RangeError('Unsupported serial baud rate')
  if (driver !== 'px4' && driver !== 'ardupilot') throw new TypeError('Unknown autopilot driver')
  if (typeof device !== 'string' || device.length > 512 || !/^\/dev\/[A-Za-z0-9_:@+.,/-]+$/.test(device) || device.split('/').some(part => part === '.' || part === '..')) throw new TypeError('Select an absolute Linux serial device under /dev')

  const path = realpathSync(device)
  if (!path.startsWith('/dev/')) throw new Error('Serial device resolves outside /dev')
  const expected = lstatSync(path)
  if (!expected.isCharacterDevice()) throw new Error('Serial path is not a character device')
  const signing = signingOptions ? createMavlinkSigning(signingOptions) : undefined
  const decoder = createMavlinkStreamDecoder(signing)
  const session = createAutopilotSession({ kind: 'telemetry-only', driver, systemId, componentId, now }, signing, {
    available: () => false,
    write() { throw new Error('Serial telemetry has no writable transport') },
  })
  const profile = driverProfiles[driver]
  const buffer = Buffer.alloc(4096)
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW
  const settingsFd = openSync(path, flags)
  let readerFd: number | undefined
  let originalSettings: string | undefined
  let matched = false, closed = false, lastFix: number | null = null
  let heartbeatSequence: number | null = null, batterySequence: number | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  function close() {
    if (closed) return
    closed = true
    clearInterval(timer)
    decoder.reset()
    session.close()
    try { if (originalSettings) terminalSettings(settingsFd, [originalSettings]) }
    finally {
      try { if (readerFd !== undefined) closeSync(readerFd) }
      finally { closeSync(settingsFd) }
    }
  }

  function poll() {
    try {
      // The nonblocking descriptor bounds the work per tick even when the peer floods the tty.
      for (let i = 0; i < 4; i++) {
        const count = readSync(readerFd!, buffer, 0, buffer.length, null)
        if (count === 0) { close(); return }
        for (const frame of decoder.push(buffer.subarray(0, count))) {
          if (frame.systemId !== systemId || frame.componentId !== componentId) continue
          if (frame.id === 0) {
            if (frame.payload[4] !== profile.vehicleType || frame.payload[5] !== profile.autopilotId) {
              if (matched) { close(); return }
              continue
            }
            if (frame.sequence === heartbeatSequence) continue
            matched = session.receive(frame)
            heartbeatSequence = frame.sequence
          }
          else if (matched && frame.id === 1) {
            const value = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getInt8(30)
            if (frame.sequence === batterySequence || value < -1 || value > 100) continue
            session.receive(frame)
            batterySequence = frame.sequence
          }
          else if (matched && frame.id === 32) {
            const payload = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
            const bootMs = payload.getUint32(0, true)
            // Upstream fix time and local receipt serve different purposes. Keep unsigned wrap valid.
            const advance = lastFix === null ? 1 : (bootMs - lastFix) >>> 0
            if (advance === 0 || advance >= 0x80000000 || ![4, 8, 12, 16, 20, 24].every(offset => Number.isFinite(payload.getFloat32(offset, true)))) continue
            session.receive(frame)
            lastFix = bootMs
          }
        }
      }
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') return
      try { close() }
      catch { /* Some detached endpoints cannot restore terminal settings. The descriptor is closed. */ }
    }
  }

  function verifyDevice(fd: number) {
    const actual = fstatSync(fd)
    if (!actual.isCharacterDevice() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.rdev !== expected.rdev) throw new Error('Serial device changed while opening')
  }
  try {
    verifyDevice(settingsFd)
    const saved = terminalSettings(settingsFd, ['-g'])
    if (!/^[0-9a-f]+(?::[0-9a-f]+)+$/i.test(saved)) throw new Error('Serial port settings are invalid')
    originalSettings = saved
    terminalSettings(settingsFd, ['raw', '-echo', 'clocal', '-hupcl', '-crtscts', '-ixon', '-ixoff', 'cs8', '-parenb', '-cstopb', String(baud), 'min', '1', 'time', '0'])
    // A child can set its standard input to blocking. Give the reader its own open file description.
    readerFd = openSync(path, flags)
    verifyDevice(readerFd)
    timer = setInterval(poll, 20)
    timer.unref()
  }
  catch (error) {
    try { close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Serial opening and cleanup failed') }
    throw error
  }
  return { device, read: session.read, close }
}
