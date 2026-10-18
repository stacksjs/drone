import type { RigidBodyState } from '../controls/physics'
import { rotateNedToBody } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { NavigationPose, RangePacket } from './perception'
export interface NavigationScene { obstacles: { id: string, northM: number, eastM: number, radiusM: number }[], groundNorthSlope: number, landingM: SensorVector }
/** Original synthetic range renderer, no hardware or full camera/LiDAR simulator claim. Truth is confined here and evaluation. */
export function createNavigationSensorFeed(delayMs = 60) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 500) throw new RangeError('Invalid modeled range latency')
  let sequence = 0
  const queue: { packet: RangePacket, pose: NavigationPose }[] = []
  let latest: { packet: RangePacket, pose: NavigationPose } | null = null
  return {
    capture(nowMs: number, truth: RigidBodyState, pose: NavigationPose, scene: NavigationScene, missingLanding = false) {
      if (nowMs % 100 !== 0) return
      if (queue.length >= 8) throw new RangeError('Modeled range queue exhausted')
      function body(world: SensorVector): SensorVector { return rotateNedToBody(truth.quaternionWxyz, world.map((n, i) => n - truth.positionM[i]!) as SensorVector).map(n => Math.round(n * 10000) / 10000) as SensorVector }
      const clusters = scene.obstacles.filter(c => Math.hypot(c.northM - truth.positionM[0], c.eastM - truth.positionM[1]) - c.radiusM <= 8).map(c => {
        const angle = Math.atan2(truth.positionM[1] - c.eastM, truth.positionM[0] - c.northM)
        const pointsBodyM = [-0.7, 0, 0.7].map(offset => body([c.northM + c.radiusM * Math.cos(angle + offset), c.eastM + c.radiusM * Math.sin(angle + offset), -1.2])) as [SensorVector, SensorVector, SensorVector]
        return { id: c.id, pointsBodyM }
      })
      const groundBodyM = [[0, 0], [1, 0], [0, 1]].map(([north, east]) => { const n = truth.positionM[0] + north!; return body([n, truth.positionM[1] + east!, scene.groundNorthSlope * n]) }) as [SensorVector, SensorVector, SensorVector]
      queue.push({ pose: structuredClone(pose), packet: { version: 1, evidence: 'modeled-range', frame: 'BODY_FRD', sequence: ++sequence, reference: pose.reference, capturedAtMs: nowMs, receivedAtMs: nowMs + delayMs, clockUncertaintyMs: 1, rangeSigmaM: 0.01, coverage: 'complete-360-model', maxRangeM: 8, clusters, groundBodyM, landing: missingLanding || Math.hypot(...scene.landingM.map((n, i) => n - truth.positionM[i]!)) > 7.5 ? null : { id: 'pad', pointBodyM: body(scene.landingM) } } })
    },
    advanceTo(nowMs: number) { while (queue[0] && queue[0].packet.receivedAtMs <= nowMs) latest = queue.shift()!; return latest ? structuredClone(latest) : null },
  }
}
