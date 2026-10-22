import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { qualifyHostFileWriteLimit } from '../fixtures/updates/host-write-limit'

// Public coordinator plus actual OS writes catches lost floors or false health
// after a partial image copy. Physical media and other errno classes are separate.
test('an actual short host-image write preserves accepted trust and needs fresh runtime confirmation after recovery', async () => {
  const evidence = process.env.RUNTIME_HOST_FILE_LIMIT_EVIDENCE
  const root = evidence ? resolve(evidence) : await mkdtemp(join(tmpdir(), 'drone-host-write-limit-'))
  if (evidence) await mkdir(root, { mode: 0o700 })
  let completed = false
  try {
    const result = await qualifyHostFileWriteLimit(join(root, 'campaign'))
    expect(result.fileLimitBytes).toBe(1048576)
    expect(result.partialImageBytes).toBe(1048576)
    expect(result.authorizedImageBytes).toBeGreaterThan(result.partialImageBytes)
    expect(result.errorCodes).toContain('EFBIG')
    expect(result.acceptedRootVersion).toBe(2)
    expect(result.acceptedTargetsVersion).toBe(3)
    expect(result.releaseFloor).toBe(9)
    expect(result.freshBootId).not.toBe(result.previousBootId)
    expect(result.physicalDeploymentAllowed).toBe(false)
    completed = true
  }
  finally {
    if (completed && !evidence) await rm(root, { recursive: true, force: true })
    else if (completed) console.log(`Host file-limit campaign retained at ${root}`)
    else console.error(`Failed host file-limit campaign retained at ${root}`)
  }
}, 120000)
