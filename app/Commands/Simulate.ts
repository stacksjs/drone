import { defineCommand } from '@stacksjs/cli'
import { createSimulator } from '../../resources/functions/drone'

export default defineCommand({
  name: 'drone:simulate',
  description: 'Run a deterministic 30-second follow simulation without hardware',
  handle() {
    const simulation = createSimulator()
    simulation.command('start')
    for (let step = 0; step < 150; step++) simulation.step()
    console.log(JSON.stringify(simulation.snapshot(), null, 2))
  },
})
