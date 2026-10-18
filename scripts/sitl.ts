import { createController, follow } from '../resources/functions/drone'
import { createUdpAdapter } from '../resources/functions/drone/udp'

if (!process.argv.includes('--enable-sitl')) {
  console.error('Use --enable-sitl only with a local ArduCopter simulator. Never forward this endpoint to hardware.')
  process.exit(1)
}

const adapter = await createUdpAdapter({ kind: 'sitl', listenPort: 14551 })
const controller = createController(adapter, follow({ distanceMeters: 10, altitudeMeters: 12, gain: 0.5 }), { targetId: 'simulated-pilot' })
const started = performance.now()
console.log('SITL demo: 30 seconds, target 20 m north of EKF origin. Pilot must select Guided and take off in the simulator.')
const timer = setInterval(() => {
  const nowMs = performance.now()
  controller.setTarget({ id: 'simulated-pilot', position: { north: 20, east: 0, down: 0 }, headingRadians: 0, confidence: 1, accuracyMeters: 0, receivedAtMs: nowMs })
  controller.enable(nowMs, 500)
  const decision = controller.tick(nowMs)
  console.log(JSON.stringify(decision))
  if (nowMs - started >= 30000) shutdown()
}, 200)

function shutdown() {
  clearInterval(timer)
  controller.close()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown)
