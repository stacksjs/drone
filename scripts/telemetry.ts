import { createUdpAdapter } from '../resources/functions/drone/udp'

const adapter = await createUdpAdapter({ kind: 'telemetry-only', listenPort: 14551 })
console.log('Receive-only telemetry on 127.0.0.1:14551. No flight commands are transmitted.')
const timer = setInterval(() => console.log(JSON.stringify(adapter.read())), 1000)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { clearInterval(timer); adapter.close(); process.exit(0) })
}
