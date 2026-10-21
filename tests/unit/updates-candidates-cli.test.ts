import { afterEach, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore } from '../../resources/functions/drone/updates/store'
import { platform, repository, target } from '../fixtures/updates/repository'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('native candidate commands require pinned trust and clock, retain identity and preserve explicit retirement semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-owned-candidate-cli-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await repository(source, { custom: { releaseSequence: 9 } })
  const enrollment = join(root, 'enrollment'), directory = join(root, 'store')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollment })
  const created = await createRuntimeTrustStore({ enrollmentDirectory: enrollment, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
  const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256, '--store-sha256', created.storeSha256]
  const reserve = await command(['updates:reserve', directory, ...flags, '--repository', source, '--trusted-system-clock-source', 'operator-managed-test-clock']).withTimeout(20000)
  expect(reserve.exitCode).toBe(0)
  const value = JSON.parse(reserve.stdout)
  expect(value.candidate.phase).toBe('prepared')
  expect(value.candidate.integrity).toBe('recorded-bytes-match')
  expect(value.candidate.currentTrustValidated).toBe(false)
  expect(value.store.releaseFloor).toBe(9)
  expect(value.physicalDeploymentAllowed).toBe(false)
  const status = await command(['updates:candidates', directory, ...flags]).withTimeout(20000)
  expect(status.exitCode).toBe(0)
  expect(JSON.parse(status.stdout)).toEqual(value)
  const missingClock = await command(['updates:reserve', directory, ...flags, '--repository', source]).withTimeout(20000)
  expect(missingClock.exitCode).toBe(1)
  expect(missingClock.stdout).toBe('')
  expect(missingClock.stderr).toBe('Runtime update store unavailable: invalid trust, clock, state or storage failure\n')
  const wrong = await command(['updates:retire', directory, ...flags, '--candidate', '0'.repeat(32)]).withTimeout(20000)
  expect(wrong.exitCode).toBe(1)
  expect(wrong.stdout).toBe('')
  const retired = await command(['updates:retire', directory, ...flags, '--candidate', value.candidate.id]).withTimeout(20000)
  expect(retired.exitCode).toBe(0)
  expect(JSON.parse(retired.stdout).candidate).toBeNull()
  expect(JSON.parse(retired.stdout).store.releaseFloor).toBe(9)
  expect(await readFile(join(value.candidate.directory, 'image.bin'))).toEqual(fixture.image)
}, 120000)
