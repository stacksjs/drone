import { afterEach, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform, repository, target } from '../fixtures/updates/repository'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('native trust commands enroll explicit policy and require the independent enrollment pin for readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-trust-cli-')); roots.push(root)
  const fixture = await repository(join(root, 'repository')), output = join(root, 'trust')
  const flags = ['--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7']
  const enrolled = await command(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', output, ...flags]).withTimeout(20000)
  expect(enrolled.exitCode).toBe(0)
  expect(enrolled.timedOut).toBe(false)
  const value = JSON.parse(enrolled.stdout)
  expect(value.policy.minimumReleaseSequence).toBe(7)
  expect(value.metadataState).toBe('initial-root-only')
  expect(value.firmwareSelectionPerformed).toBe(false)
  const inspected = await command(['updates:trust', output, '--enrollment-sha256', value.enrollmentSha256]).withTimeout(20000)
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout)).toEqual(value)
  const rejected = await command(['updates:trust', output, '--enrollment-sha256', '0'.repeat(64)]).withTimeout(20000)
  expect(rejected.exitCode).toBe(1)
  expect(rejected.stdout).toBe('')
  expect(rejected.stderr).toBe('Runtime trust unavailable: invalid enrollment pin or protected state\n')
  const missing = await command(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', join(root, 'missing-policy')]).withTimeout(20000)
  expect(missing.exitCode).toBe(1)
  expect(missing.stdout).toBe('')
  expect(await Bun.file(join(root, 'missing-policy/enrollment.json')).exists()).toBe(false)
}, 100000)
