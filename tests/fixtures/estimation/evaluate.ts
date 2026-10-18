import motion from './motion-v1.json'
import reference from './truth-v1.json'
import { createEstimatorReplay } from '../../../resources/functions/drone/estimation/replay'
const replay = createEstimatorReplay(motion)
let maxAngleRad = 0, sumAngle2 = 0, maxPositionM = 0, sumPosition2 = 0, count = 0
for (const row of reference.truth.slice(25)) {
  const result = replay.advanceTo(row.atMs + 40).estimate
  if (!result.health.tilt || !result.health.localPosition || !result.attitude || !result.localPosition) throw new Error('Synthetic reference estimator unhealthy')
  const actual = reference.truth.find(t => t.atMs === result.attitude!.capturedAtMs)!
  const angularError = Math.hypot(...result.attitude.eulerRad.map((n, i) => n - actual.eulerRad[i]!))
  const t = result.localPosition.predictedToMs / 1000
  const positionError = Math.hypot(...result.localPosition.positionM.map((n, i) => n - [2 * t, t, -0.5 * t][i]!))
  maxAngleRad = Math.max(maxAngleRad, angularError); sumAngle2 += angularError ** 2
  maxPositionM = Math.max(maxPositionM, positionError); sumPosition2 += positionError ** 2; count++
}
console.log(JSON.stringify({ evidence: 'analytic-synthetic-truth-only', count, eulerErrorMaxRad: maxAngleRad, eulerErrorRmsRad: Math.sqrt(sumAngle2 / count), positionErrorMaxM: maxPositionM, positionErrorRmsM: Math.sqrt(sumPosition2 / count), absoluteHeadingObserved: false, hardwareValidated: false }, null, 2))
