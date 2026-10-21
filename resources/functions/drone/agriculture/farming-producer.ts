import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface FarmingFileIdentity { byteLength: number, sha256: string }
export interface FarmingProducerSnapshot {
  version: 1
  evidence: 'observed-software-content-identities'
  authenticatedExecution: false
  loadedGraphAttested: false
  process: {
    runtime: 'bun'
    version: string
    revision: string
    standalone: boolean
    executable: FarmingFileIdentity
  }
  implementation:
    | { method: 'observed-standalone-process-executable' }
    | { method: 'observed-declared-source-files', profile: 'farming-collection-source-v1', files: (FarmingFileIdentity & { path: string })[] }
}
export interface FarmingProducerObservation extends FarmingProducerSnapshot {
  observationInterval: 'before-collection-and-after-dataset-readback'
  observationsUnchanged: true
}

// A finite named content scope, including type-only files. No loaded-graph or dependency attestation.
// Bare packages, builtins, preloads and unrelated host imports are outside this profile.
const sourcePaths = [
  'app/Commands/FarmingCollect.ts',
  'bin/drone.ts',
  'resources/functions/artifacts/completed-directory.ts',
  'resources/functions/cli/output.ts',
  'resources/functions/drone/agriculture/camera.ts',
  'resources/functions/drone/agriculture/evidence.ts',
  'resources/functions/drone/agriculture/export.ts',
  'resources/functions/drone/agriculture/farming-collection.ts',
  'resources/functions/drone/agriculture/farming-producer.ts',
  'resources/functions/drone/agriculture/fixtures.ts',
  'resources/functions/drone/agriculture/layer.ts',
  'resources/functions/drone/agriculture/planner.ts',
  'resources/functions/drone/agriculture/radiometry.ts',
  'resources/functions/drone/agriculture/runtime.ts',
  'resources/functions/drone/agriculture/types.ts',
  'resources/functions/drone/authority/core.ts',
  'resources/functions/drone/authority/supervisor.ts',
  'resources/functions/drone/authority/watchdog-core.ts',
  'resources/functions/drone/authority/watchdog.ts',
  'resources/functions/drone/camera/calibrated.ts',
  'resources/functions/drone/camera/types.ts',
  'resources/functions/drone/controls/allocation.ts',
  'resources/functions/drone/controls/controller.ts',
  'resources/functions/drone/controls/model.ts',
  'resources/functions/drone/controls/physics.ts',
  'resources/functions/drone/controls/pid.ts',
  'resources/functions/drone/controls/sensors.ts',
  'resources/functions/drone/estimation/estimator.ts',
  'resources/functions/drone/estimation/frames.ts',
  'resources/functions/drone/estimation/position.ts',
  'resources/functions/drone/mapping/camera.ts',
  'resources/functions/drone/mapping/fixtures.ts',
  'resources/functions/drone/mapping/geometry.ts',
  'resources/functions/drone/mapping/planner.ts',
  'resources/functions/drone/mapping/quality.ts',
  'resources/functions/drone/mapping/runtime.ts',
  'resources/functions/drone/mapping/types.ts',
  'resources/functions/drone/missions/engine.ts',
  'resources/functions/drone/missions/files.ts',
  'resources/functions/drone/missions/graph.ts',
  'resources/functions/drone/missions/plan.ts',
  'resources/functions/drone/missions/recording.ts',
  'resources/functions/drone/missions/simulation.ts',
  'resources/functions/drone/missions/vehicle.ts',
  'resources/functions/drone/payloads/modeled-camera.ts',
  'resources/functions/drone/payloads/modeled-shutter.ts',
  'resources/functions/drone/runtime/protocol.ts',
  'resources/functions/drone/sensors/calibration.ts',
  'resources/functions/drone/sensors/pipeline.ts',
  'resources/functions/drone/sensors/protocol.ts',
  'resources/functions/drone/sensors/types.ts',
  'resources/functions/drone/vehicles/measurements.ts',
  'resources/functions/drone/vehicles/types.ts',
  'resources/functions/drone/vision/types.ts',
  'resources/functions/drone/volumes/geometry.ts',
  'resources/functions/drone/volumes/types.ts',
 ] as const

async function observeFile(path: string, maxBytes: number): Promise<FarmingFileIdentity> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes) throw new Error('Content unavailable')
    const hash = createHash('sha256'), buffer = new Uint8Array(65536)
    let byteLength = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      byteLength += bytesRead
      if (byteLength > maxBytes) throw new Error('Content limit')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat()
    if (byteLength !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Content changed')
    return { byteLength, sha256: hash.digest('hex') }
  }
  finally { await file.close() }
}

/** Host-derived named file contents only. Neither disk observations nor mode detection authenticate execution. */
export async function observeFarmingProducer(): Promise<FarmingProducerSnapshot> {
  try {
    if (typeof Bun === 'undefined' || typeof Bun.isStandaloneExecutable !== 'boolean' || typeof process.execPath !== 'string' || process.execPath.length < 1 || process.execPath.length > 4096 || process.execPath.includes('\0')) throw new Error('Host capability unavailable')
    if (![Bun.version, Bun.revision].every(value => typeof value === 'string' && /^[\x21-\x7E]{1,128}$/.test(value))) throw new Error('Host version unavailable')
    const executable = await observeFile(process.execPath, 256 * 1024 * 1024)
    if (executable.byteLength < 1) throw new Error('Empty runtime')
    const snapshot: FarmingProducerSnapshot = {
      version: 1, evidence: 'observed-software-content-identities', authenticatedExecution: false, loadedGraphAttested: false,
      process: { runtime: 'bun', version: Bun.version, revision: Bun.revision, standalone: Bun.isStandaloneExecutable, executable },
      implementation: { method: 'observed-standalone-process-executable' },
    }
    if (!snapshot.process.standalone) {
      if (sourcePaths.length > 256) throw new Error('Profile limit')
      const root = resolve(import.meta.dir, '../../../..')
      const files: (FarmingFileIdentity & { path: string })[] = []
      let total = 0
      for (const path of sourcePaths) {
        if (path.length > 240) throw new Error('Profile path limit')
        const identity = await observeFile(resolve(root, path), 8 * 1024 * 1024 - total)
        total += identity.byteLength
        files.push({ path, ...identity })
      }
      snapshot.implementation = { method: 'observed-declared-source-files', profile: 'farming-collection-source-v1', files }
    }
    return snapshot
  }
  catch { throw new Error('farming-collection-unavailable') }
}
