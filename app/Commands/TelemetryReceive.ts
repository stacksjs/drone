import { setTimeout as delay } from 'node:timers/promises'
import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '@stacksjs/cli/output'
import type { AutopilotAdapter } from '../../resources/functions/drone/udp'
import { createUdpAdapter } from '../../resources/functions/drone/udp'

export default defineCommand({
  name: 'telemetry:receive <driver>',
  description: 'Watch receive-only MAVLink telemetry on loopback using the selected autopilot profile',
  options: {
    '--port <port>': { description: 'Loopback UDP port (0 asks the OS to select a port)', default: '14551' },
  },
  async handle(options, driver) {
    const stop = new AbortController()
    let adapter: AutopilotAdapter | undefined
    const interrupt = () => { stop.abort(); adapter?.close() }
    try {
      if (driver !== 'px4' && driver !== 'ardupilot') throw new Error('Select px4 or ardupilot')
      if (!/^\d{1,5}$/.test(options.port) || Number(options.port) > 65535) throw new Error('Invalid loopback UDP port')
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      adapter = await createUdpAdapter({ kind: 'telemetry-only', driver, listenPort: Number(options.port) })
      if (stop.signal.aborted) return
      await printAsync(`Receive-only ${driver} telemetry on 127.0.0.1:${adapter.localPort}`)
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
      adapter?.close()
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  },
})
