import { authorityScenarios } from '../../../resources/functions/drone/authority/harness'
import { authorityPolicy } from '../../../resources/functions/drone/authority/supervisor'
import { simulateMultirotor } from '../../../resources/functions/drone/controls/simulation'
const report = {
  evidence: 'deterministic-software-simulation', physicalFlightEnabled: false, boardOutputsInhibited: true, hardwareInLoop: false,
  policy: authorityPolicy,
  injectionAtMs: 3000,
  scenarios: authorityScenarios.map(scenario => {
    const run = simulateMultirotor({ authorityScenario: scenario, seconds: scenario === 'nominal' ? 20 : 8 })
    return { scenario, ...run.authority, lastEstimatorAtMs: run.estimate.nowMs, lastControllerAtMs: run.control?.atMs, finalPositionErrorM: run.metrics.finalPositionErrorM, groundContacts: run.metrics.groundContacts, finalCommandN: run.trace.at(-1)!.motorsN }
  }),
}
const destination = process.argv[2] ?? new URL('../../../docs/authority-evidence.json', import.meta.url).pathname
await Bun.write(destination, `${JSON.stringify(report, (key, value) => typeof value === 'bigint' ? String(value) : value, 2)}\n`)
