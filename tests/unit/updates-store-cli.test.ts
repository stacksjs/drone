import { afterEach, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { repository, platform, target } from '../fixtures/updates/repository'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('native store commands require independent pins and an explicit trusted system-clock source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-store-cli-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await repository(source, { custom: { releaseSequence: 9 } })
  const enrollment = join(root, 'enrollment'), output = join(root, 'store')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollment })
  const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256]
  const initialized = await command(['updates:store-init', ...flags, '--output', output]).withTimeout(20000)
  expect(initialized.exitCode).toBe(0)
  const created = JSON.parse(initialized.stdout)
  expect(created.releaseFloor).toBe(7)
  const pinned = [...flags, '--store-sha256', created.storeSha256]
  const missingClock = await command(['updates:refresh', output, ...pinned, '--repository', source]).withTimeout(20000)
  expect(missingClock.exitCode).toBe(1)
  expect(missingClock.stdout).toBe('')
  const refreshed = await command(['updates:refresh', output, ...pinned, '--repository', source, '--trusted-system-clock-source', 'operator-managed-test-clock']).withTimeout(20000)
  expect(refreshed.exitCode).toBe(0)
  const value = JSON.parse(refreshed.stdout)
  expect(value.generation).toBe(3)
  expect(value.releaseFloor).toBe(9)
  expect(value.physicalDeploymentAllowed).toBe(false)
  const inspected = await command(['updates:store', output, ...pinned]).withTimeout(20000)
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout)).toEqual(value)
  const wrongPin = await command(['updates:store', output, ...flags, '--store-sha256', '0'.repeat(64)]).withTimeout(20000)
  expect(wrongPin.exitCode).toBe(1)
  expect(wrongPin.stdout).toBe('')
}, 120000)
