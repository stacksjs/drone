import { createSimulator } from '../resources/functions/drone'

const simulation = createSimulator()
simulation.command('start')
for (let step = 0; step < 150; step++) {
  if (step === 75) simulation.command('lose-target')
  if (step === 90) simulation.command('restore-target')
  const snapshot = simulation.step()
  if (step % 10 === 0) console.log(JSON.stringify({ seconds: snapshot.nowMs / 1000, position: snapshot.telemetry.position, decision: snapshot.decision }))
}
