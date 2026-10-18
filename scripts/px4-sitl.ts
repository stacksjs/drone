import { createController, follow } from '../resources/functions/drone'
import { createPx4Driver } from '../resources/functions/drone/drivers'

if (!process.argv.includes('--enable-sitl')) {
  console.error('Use --enable-sitl only with local PX4 quadcopter SITL. No hardware forwarding.')
  process.exit(1)
}
const adapter = await createPx4Driver({ kind: 'sitl', listenPort: 14540 })
const controller = createController(adapter, follow({ distanceMeters: 10, altitudeMeters: 12, gain: 0.5 }), { targetId: 'simulated-pilot' })
const started = performance.now()
let active = false
console.log('PX4 SITL: priming for Offboard. Use the simulator ground station to take off and select Offboard explicitly. No arm or mode commands are sent.')
const timer = setInterval(() => {
  const nowMs = performance.now()
  if (!active) {
    const preparation = adapter.primeOffboard()
    const telemetry = adapter.read()
    active = preparation.ready && telemetry?.mode === 'guided' && telemetry.armed
    console.log(JSON.stringify(preparation))
  }
  else {
    controller.setTarget({ id: 'simulated-pilot', position: { north: 20, east: 0, down: 0 }, headingRadians: 0, confidence: 1, accuracyMeters: 0, receivedAtMs: nowMs })
    controller.enable(nowMs, 500)
    const decision = controller.tick(nowMs)
    console.log(JSON.stringify(decision))
    if (decision.kind === 'release') shutdown()
  }
  if (nowMs - started >= 30000) shutdown()
}, 200)
function shutdown() { clearInterval(timer); controller.close() }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown)
