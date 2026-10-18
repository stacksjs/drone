import { createEstimator } from '../estimation/estimator'
import { createRigidBody } from '../controls/physics'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createPayloadPoseTimeline } from './pose'
import { createPayloadCaptureSession } from './capture'
import { createReplayCameraPayload } from './replay'

export const payloadScenarios = ['nominal', 'wrong-identity', 'stale-clock', 'lost-ack', 'pose-reset'] as const
export type PayloadScenario = typeof payloadScenarios[number]
/** Camera fixture attached to the owned sensor and estimator pipeline. No device I/O. */
export async function runPayloadBench(scenario: PayloadScenario = 'nominal') {
  if (!payloadScenarios.includes(scenario)) throw new RangeError('Unknown payload scenario')
  const body = createRigidBody(), feed = createPhysicsSensorFeed(0), estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only' }), poses = createPayloadPoseTimeline()
  let clock = 0, triggers = 0
  const advance = (until: number) => {
    for (; clock <= until; clock += 4) {
      feed.capture(body.snapshot(), clock)
      const estimate = estimator.update(feed.advanceTo(clock))
      if (clock % 20 === 0) poses.record(estimate, clock)
    }
    clock = until
  }
  advance(600)
  const adapter = createReplayCameraPayload({ now: () => clock, captureAt: () => 620, fault: scenario === 'pose-reset' ? 'none' : scenario === 'nominal' ? 'none' : scenario, onTrigger() { triggers++; clock = 604; advance(640); if (scenario === 'pose-reset') poses.clear('bench-reset') } })
  const session = createPayloadCaptureSession({ adapter, poses, now: () => clock })
  try {
    const capture = await session.capture({ requirePose: true })
    return { scenario, evidence: 'owned-estimator-camera-fixture' as const, triggers, outcome: 'captured' as const, capture }
  }
  catch (error) {
    if (scenario === 'nominal') throw error
    return { scenario, evidence: 'owned-estimator-camera-fixture' as const, triggers, outcome: 'rejected' as const, error: error instanceof Error ? error.message : String(error), capture: null }
  }
  finally { session.close() }
}
/** Serialize metadata without image bytes; bigint boot identifiers remain exact decimal strings. */
export function payloadJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => key === 'jpeg' ? undefined : typeof item === 'bigint' ? String(item) : item, 2)
}
