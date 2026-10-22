import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRuntimeTrustStore } from '../../resources/functions/drone/updates/store'
import { maintenanceScenario } from '../fixtures/updates/maintenance-scenario'

test('native maintenance requires explicit unresolved-input acknowledgement and verifies fresh metadata with retained pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-maintenance-cli-'))
  let completed = false
  try {
    const item = await maintenanceScenario(root, { source: 'operator-managed-test-clock', read: () => new Date() })
    await item.signed.publish({ image: item.signed.image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    const flags = ['--enrollment', item.reference.enrollmentDirectory, '--enrollment-sha256', item.reference.enrollmentSha256, '--store-sha256', item.reference.storeSha256, '--repository', item.source, '--trusted-system-clock-source', 'operator-managed-test-clock', '--attempt', item.failed.attempt!.id]
    const noAcknowledgement = await command(['updates:maintain', item.reference.directory, ...flags]).withTimeout(20000)
    expect(noAcknowledgement.exitCode).toBe(1)
    expect(noAcknowledgement.stdout).toBe('')
    expect(await inspectRuntimeTrustStore(item.reference)).toEqual(item.failed)
    const result = await command(['updates:maintain', item.reference.directory, ...flags, '--acknowledge-unresolved-inputs']).withTimeout(20000)
    expect(result.exitCode).toBe(0)
    const observed = JSON.parse(result.stdout)
    expect(observed.attempt.phase).toBe('verified')
    expect(observed.maintenanceHandoffs[0].previousAttempt).toEqual(item.failed.attempt)
    expect(observed.releaseFloor).toBe(9)
    expect(observed.physicalDeploymentAllowed).toBe(false)
    const staleAttempt = await command(['updates:maintain', item.reference.directory, ...flags, '--acknowledge-unresolved-inputs']).withTimeout(20000)
    expect(staleAttempt.exitCode).toBe(1)
    expect(staleAttempt.stdout).toBe('')
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed maintenance CLI case retained at ${root}`)
  }
}, 120000)
