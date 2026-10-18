import { navigationScenarios, simulateNavigation } from '../resources/functions/drone/navigation/simulation'
const evidence = {
  version: 1,
  kind: 'owned-navigation-physics-simulation',
  perceptionModel: 'quantized-body-range-arcs-and-plane-samples',
  latencyEvidence: 'measured-on-virtual-capture-delivery-clock',
  physicalLatencyMeasured: false,
  physicalFlightEnabled: false,
  scenarios: navigationScenarios.map(scenario => {
    const result = simulateNavigation({ scenario })
    return { scenario, mission: result.mission.state, navigation: result.navigation?.state, reason: result.navigation?.reason, ...result.metrics, elapsedMs: result.mission.elapsedMs, modeledOutputsNeutral: result.board.motorsN.every(n => n === 0) }
  }),
}
await Bun.write(new URL('../docs/navigation-evidence.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`)
