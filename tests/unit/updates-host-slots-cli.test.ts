import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, reserveRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { repository, target } from '../fixtures/updates/repository'

test('native host slot commands share actual health, fresh rollback and fixed rejection semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-slot-cli-'))
  try {
    const project = process.cwd(), build = await buildRuntime({ project })
    const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const sourceRevision = (await new Response(git.stdout).text()).trim()
    expect(await git.exited).toBe(0)
    const source = join(root, 'repository'), image = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
    const signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollment = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollment })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory: enrollment, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory: enrollment, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const reserved = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock: { source: 'fixture-system-clock', read: () => new Date() } })
    const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256, '--store-sha256', created.storeSha256]
    const current = ['--repository', source, '--trusted-system-clock-source', 'operator-managed-test-clock', '--project', project]
    const trial = await command(['updates:trial', directory, ...flags, ...current, '--candidate', reserved.candidate!.id]).withTimeout(20000)
    expect(trial.exitCode).toBe(0)
    const first = JSON.parse(trial.stdout)
    expect(first.knownGood.candidateId).toBe(reserved.candidate!.id)
    expect(first.knownGood.health.cleanProcessExit).toBe(true)
    expect(first.physicalDeploymentAllowed).toBe(false)
    const status = await command(['updates:slots', directory, ...flags]).withTimeout(20000)
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout)).toEqual(first)
    const missing = await command(['updates:trial', directory, ...flags, '--repository', source, '--candidate', reserved.candidate!.id, '--trusted-system-clock-source', 'operator-managed-test-clock']).withTimeout(20000)
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toBe('Runtime update store unavailable: invalid trust, clock, state or storage failure\n')
    const rollback = await command(['updates:rollback', directory, ...flags, ...current]).withTimeout(20000)
    expect(rollback.exitCode).toBe(0)
    const next = JSON.parse(rollback.stdout)
    expect(next.knownGood.candidateId).toBe(first.knownGood.candidateId)
    expect(next.knownGood.health.bootId).not.toBe(first.knownGood.health.bootId)
    const wrong = await command(['updates:abandon', directory, ...flags, '--trial', next.knownGood.id]).withTimeout(20000)
    expect(wrong.exitCode).toBe(1)
    expect(wrong.stdout).toBe('')
    expect(wrong.stderr).toBe('Runtime update store unavailable: invalid trust, clock, state or storage failure\n')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 120000)
