import { setTimeout as delay } from 'node:timers/promises'
import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '@stacksjs/cli/output'
import type { AutopilotAdapter } from '../../resources/functions/drone/udp'
import type { SerialTelemetryReader } from '../../resources/functions/drone/serial'
import { openSerialTelemetry } from '../../resources/functions/drone/serial'
import { createUdpAdapter } from '../../resources/functions/drone/udp'

export default defineCommand({
  name: 'telemetry:receive <driver>',
  description: 'Watch receive-only MAVLink telemetry over Linux serial or loopback UDP',
  options: {
    '--port <port>': 'Loopback UDP port, defaults to 14551 (0 asks the OS to select a port)',
    '--serial <device>': 'Linux serial device under /dev, preferably a stable /dev/serial/by-id path',
    '--baud <rate>': 'Serial baud rate, defaults to 115200',
  },
  async handle(options, driver) {
    const stop = new AbortController()
    let adapter: AutopilotAdapter | SerialTelemetryReader | undefined
    const interrupt = () => { stop.abort() }
    try {
      if (driver !== 'px4' && driver !== 'ardupilot') throw new Error('Select px4 or ardupilot')
      if (options.serial !== undefined && options.port !== undefined || options.baud !== undefined && options.serial === undefined) throw new Error('Select either a serial device and optional baud rate or a loopback UDP port')
      if (options.baud !== undefined && !/^\d{1,6}$/.test(options.baud)) throw new Error('Invalid serial baud rate')
      const port = options.port ?? '14551'
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('Invalid loopback UDP port')
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      adapter = options.serial !== undefined
        ? openSerialTelemetry({ device: options.serial, driver, ...(options.baud === undefined ? {} : { baud: Number(options.baud) }) })
        : await createUdpAdapter({ kind: 'telemetry-only', driver, listenPort: Number(port) })
      if (stop.signal.aborted) return
      const source = 'device' in adapter ? adapter.device : `127.0.0.1:${adapter.localPort}`
      await printAsync(`Receive-only ${driver} telemetry on ${source}`)
      while (!stop.signal.aborted) {
        await delay(1000, undefined, { signal: stop.signal })
        const sample = adapter.read()
        if (!sample) throw new Error('Telemetry receiver unavailable')
        await printAsync(JSON.stringify(sample))
      }
    }
    catch (error) {
      if (stop.signal.aborted && error instanceof Error && error.name === 'AbortError') return
      process.exitCode = 1
      try { await printErrorAsync(error instanceof Error ? error.message : 'Telemetry receiver unavailable') }
      catch { /* A closed error stream cannot deliver a diagnostic. */ }
    }
    finally {
      try { adapter?.close() }
      catch {
        process.exitCode = 1
        try { await printErrorAsync('Unable to restore the telemetry serial port settings') }
        catch { /* A closed error stream cannot deliver a diagnostic. */ }
      }
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  },
})
