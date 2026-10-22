import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { qualifyHostFullVolume } from '../fixtures/updates/host-volume-full'

// Actual privileged Linux namespace qualification only. A skip is not ENOSPC evidence.
for (const imageWriteBudgetBytes of [1048576, 0] as const) test.skipIf(process.env.RUNTIME_HOST_ENOSPC_TEST !== '1')(`a full host filesystem with ${imageWriteBudgetBytes} image bytes available requires explicit recovery before fresh confirmation`, async () => {
  const evidence = process.env.RUNTIME_HOST_ENOSPC_EVIDENCE
  const temporary = evidence ? undefined : await mkdtemp(join(tmpdir(), 'drone-host-enospc-'))
  if (evidence) await mkdir(resolve(evidence), { recursive: true, mode: 0o700 })
  const root = evidence ? join(resolve(evidence), imageWriteBudgetBytes === 0 ? 'zero-write' : 'short-write') : join(temporary!, 'campaign')
  let completed = false
  try {
    const result = await qualifyHostFullVolume(root, imageWriteBudgetBytes)
    expect(result.filesystemType).toBe('tmpfs')
    expect(result.filesystemBytes).toBe(16777216)
    expect(result.freeBytesAfterFailure).toBe(0)
    expect(result.imageWriteBudgetBytes).toBe(imageWriteBudgetBytes)
    expect(result.partialImageBytes).toBe(imageWriteBudgetBytes)
    if (imageWriteBudgetBytes === 0) expect(result.partialImageSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(result.partialImageBytes).toBeLessThan(result.authorizedImageBytes)
    expect(result.errorCodes).toContain('ENOSPC')
    expect(result.errorCodes).toContain('SQLITE_FULL')
    expect(result.interruptedPhase).toBe('selected')
    expect(result.interruptedAttempt).toBe('pending')
    expect(result.acceptedRootVersion).toBe(2)
    expect(result.acceptedTargetsVersion).toBe(3)
    expect(result.releaseFloor).toBe(9)
    expect(result.abandonedPhase).toBe('abandoned')
    expect(result.freshBootId).not.toBe(result.previousBootId)
    expect(result.physicalDeploymentAllowed).toBe(false)
    completed = true
  }
  finally {
    if (completed && temporary) await rm(temporary, { recursive: true, force: true })
    else console.log(`Host full-volume campaign retained at ${root}`)
  }
}, 180000)
