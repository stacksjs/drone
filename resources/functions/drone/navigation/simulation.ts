import type { NavigationScenario } from './runtime'
import { runNavigationFixture } from './runtime'
export { navigationScenarios } from './runtime'
export type { NavigationScenario } from './runtime'
/** Existing scripted fixture; explicit retained experiments use the private runtime module. */
export function simulateNavigation(options: { scenario?: NavigationScenario, seconds?: number } = {}) {
  return runNavigationFixture(options)
}
