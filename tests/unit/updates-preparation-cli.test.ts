import { afterEach, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore } from '../../resources/functions/drone/updates/store'
import { repository, platform, target } from '../fixtures/updates/repository'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('native preparation requires protected trust and an explicit clock, authenticates the image and preserves failure status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-prepare-cli-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await repository(source, { custom: { releaseSequence: 9 } })
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
  const flags = ['--enrollment', enrollmentDirectory, '--enrollment-sha256', enrolled.enrollmentSha256, '--store-sha256', created.storeSha256]
  const sourceFlags = ['--repository', source, '--trusted-system-clock-source', 'operator-managed-test-clock']
  const prepared = await command(['updates:prepare', join(root, 'store'), ...flags, ...sourceFlags, '--output', join(root, 'candidate')]).withTimeout(20000)
  expect(prepared.exitCode).toBe(0)
  const value = JSON.parse(prepared.stdout)
  expect(value.store.releaseFloor).toBe(9)
  expect(value.candidate.sha256).toBe(fixture.imageHash)
  expect(value.trustStatePersisted).toBe(true)
  expect(value.physicalDeploymentAllowed).toBe(false)
  const inspected = await command(['updates:inspect', join(root, 'candidate'), '--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '9']).withTimeout(20000)
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout)).toEqual(value.candidate)
  const missingClock = await command(['updates:prepare', join(root, 'store'), ...flags, '--repository', source, '--output', join(root, 'missing-clock')]).withTimeout(20000)
  expect(missingClock.exitCode).toBe(1)
  expect(missingClock.stdout).toBe('')
  await writeFile(fixture.imagePath, Buffer.alloc(fixture.image.length, 0xff))
  const rejected = await command(['updates:prepare', join(root, 'store'), ...flags, ...sourceFlags, '--output', join(root, 'bad-image')]).withTimeout(20000)
  expect(rejected.exitCode).toBe(1)
  expect(rejected.stdout).toBe('')
  expect(rejected.stderr).toBe('Runtime image preparation unavailable: invalid trust, clock, rejected image or output failure\n')
  const status = await command(['updates:store', join(root, 'store'), ...flags]).withTimeout(20000)
  expect(status.exitCode).toBe(0)
  const stopped = JSON.parse(status.stdout)
  expect(stopped.releaseFloor).toBe(9)
  expect(stopped.attempt.phase).toBe('maintenance')
  expect(stopped.physicalDeploymentAllowed).toBe(false)
}, 120000)
