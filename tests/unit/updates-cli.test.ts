import { afterEach, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repository, platform, target } from '../fixtures/updates/repository'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('native update commands stage and reverify with explicit caller trust, then reject a raised floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-update-cli-')); roots.push(root)
  const repo = join(root, 'repo'), output = join(root, 'candidate'), fixture = await repository(repo)
  const flags = ['--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7']
  const staged = await command(['updates:stage', repo, '--trusted-root', fixture.rootPath, '--output', output, ...flags]).withTimeout(20000)
  expect(staged.exitCode).toBe(0)
  expect(staged.timedOut).toBe(false)
  const value = JSON.parse(staged.stdout)
  expect(value.sha256).toBe(fixture.imageHash)
  expect(value.physicalDeploymentAllowed).toBe(false)
  const inspected = await command(['updates:inspect', output, ...flags]).withTimeout(20000)
  expect(inspected.exitCode).toBe(0)
  expect(JSON.parse(inspected.stdout)).toEqual(value)
  const rejected = await command(['updates:inspect', output, ...flags.slice(0, -1), '8']).withTimeout(20000)
  expect(rejected.exitCode).toBe(1)
  expect(rejected.stdout).toBe('')
  expect(rejected.stderr).toBe('Firmware candidate unavailable: invalid trust, rejected image or output failure\n')
  const missing = await command(['updates:inspect', output]).withTimeout(20000)
  expect(missing.exitCode).toBe(1)
  expect(missing.stdout).toBe('')
}, 100000)
