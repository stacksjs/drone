import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { digest, platform, repository, target } from '../fixtures/updates/repository'
import type { RuntimeFirmwarePolicy } from '../../resources/functions/drone/updates/staging'
import { enrollRuntimeTrust, inspectRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('independently pinned root and release policy can be enrolled and verified after readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-trust-enrollment-')); roots.push(root)
  const fixture = await repository(join(root, 'repository')), output = join(root, 'trust')
  const policy = { target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7 } satisfies RuntimeFirmwarePolicy
  const result = enrollRuntimeTrust({ ...policy, trustedRoot: fixture.rootPath, output })
  expect(result.policy).toEqual(policy)
  expect(result.rootVersion).toBe(1)
  expect(result.metadataState).toBe('initial-root-only')
  expect(result.metadataRefreshPerformed).toBe(false)
  expect(result.firmwareSelectionPerformed).toBe(false)
  expect(result.physicalDeploymentAllowed).toBe(false)
  expect(result.enrollmentSha256).toBe(digest(await readFile(join(output, 'enrollment.json'))))
  expect(await readFile(join(output, 'root.json'))).toEqual(await readFile(fixture.rootPath))
  expect(inspectRuntimeTrust({ directory: output, enrollmentSha256: result.enrollmentSha256 })).toEqual(result)
  expect((await readdir(output)).sort()).toEqual(['enrollment.json', 'root.json'])
  expect((await stat(output)).mode & 0o777).toBe(0o700)
  expect((await stat(join(output, 'enrollment.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(output, 'root.json'))).mode & 0o777).toBe(0o600)
})


test('trust readback requires an owned parent protected from other principals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-trust-parent-')); roots.push(root)
  const fixture = await repository(join(root, 'repository')), directory = join(root, 'trust')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: directory })
  await chmod(root, 0o777)
  try { expect(() => inspectRuntimeTrust({ directory, enrollmentSha256: enrolled.enrollmentSha256 })).toThrow() }
  finally { await chmod(root, 0o700) }
})


async function setup(options: Parameters<typeof repository>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drone-trust-enrollment-')); roots.push(root)
  const fixture = await repository(join(root, 'repository'), options), output = join(root, 'trust')
  return { root, fixture, output, input: { target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output } satisfies Parameters<typeof enrollRuntimeTrust>[0] }
}

test('bad pins, unsafe policy and malformed roots cannot complete enrollment', async () => {
  const item = await setup()
  for (const [i, change] of [{ trustedRootSha256: '0'.repeat(64) }, { trustedRootSha256: '' }, { minimumReleaseSequence: 0 }, { minimumReleaseSequence: Number.NaN }, { minimumReleaseSequence: 7.5 }, { target: '../image.bin' }].entries()) {
    const output = join(item.root, `invalid-${i}`)
    expect(() => enrollRuntimeTrust({ ...item.input, ...change, output })).toThrow()
    expect(await Bun.file(join(output, 'enrollment.json')).exists()).toBe(false)
  }
  for (const options of [{ nonCanonicalRoot: true }, { metadataFields: { root: { expires: 'not-a-date' } } }, { metadataFields: { root: { version: 0 } } }]) {
    const bad = await setup(options)
    expect(() => enrollRuntimeTrust(bad.input)).toThrow()
    expect(await Bun.file(join(bad.output, 'enrollment.json')).exists()).toBe(false)
  }
})

test('a pinned root still requires its authorized self-signatures', async () => {
  const item = await setup(), root = JSON.parse(await readFile(item.fixture.rootPath, 'utf8'))
  root.signatures[0].sig = '0'.repeat(128)
  const bytes = Buffer.from(JSON.stringify(root))
  await writeFile(item.fixture.rootPath, bytes)
  expect(() => enrollRuntimeTrust({ ...item.input, trustedRootSha256: digest(bytes) })).toThrow()
  expect(await Bun.file(join(item.output, 'enrollment.json')).exists()).toBe(false)
})

test('readback rejects a wrong independent pin, modified root, altered record and invalid schema', async () => {
  const item = await setup(), enrolled = enrollRuntimeTrust(item.input)
  const manifestPath = join(item.output, 'enrollment.json'), original = await readFile(manifestPath), record = JSON.parse(original.toString())
  for (const enrollmentSha256 of ['', '0'.repeat(64)]) expect(() => inspectRuntimeTrust({ directory: item.output, enrollmentSha256 })).toThrow()
  const changed = { ...record, policy: { ...record.policy, minimumReleaseSequence: 1 } }
  await writeFile(manifestPath, JSON.stringify(changed))
  expect(() => inspectRuntimeTrust({ directory: item.output, enrollmentSha256: enrolled.enrollmentSha256 })).toThrow()
  const invalid = [{ ...record, schema: 'unknown' }, { ...record, extra: true }, { ...record, enrollmentId: '../bad' }, { ...record, rootVersion: 2 }, { ...record, policy: { ...record.policy, minimumReleaseSequence: 0 } }, { ...record, policy: { ...record.policy, extra: true } }]
  for (const value of invalid) {
    const bytes = Buffer.from(JSON.stringify(value)); await writeFile(manifestPath, bytes)
    expect(() => inspectRuntimeTrust({ directory: item.output, enrollmentSha256: digest(bytes) })).toThrow()
  }
  await writeFile(manifestPath, original)
  await writeFile(join(item.output, 'root.json'), '{}')
  expect(() => inspectRuntimeTrust({ directory: item.output, enrollmentSha256: enrolled.enrollmentSha256 })).toThrow()
})

test('source symlinks and shared writable storage are rejected', async () => {
  const linked = await setup(), link = join(linked.root, 'root-link.json')
  await symlink(linked.fixture.rootPath, link)
  expect(() => enrollRuntimeTrust({ ...linked.input, trustedRoot: link })).toThrow()
  const shared = await setup()
  await chmod(shared.root, 0o777)
  expect(() => enrollRuntimeTrust(shared.input)).toThrow()
  await chmod(shared.root, 0o700)
  const result = enrollRuntimeTrust(shared.input)
  await chmod(shared.output, 0o777)
  expect(() => inspectRuntimeTrust({ directory: shared.output, enrollmentSha256: result.enrollmentSha256 })).toThrow()
  await chmod(shared.output, 0o700)
})

test('an existing enrollment or partial directory is never overwritten or implicitly repaired', async () => {
  const item = await setup(), enrolled = enrollRuntimeTrust(item.input)
  const marker = await readFile(join(item.output, 'enrollment.json'))
  expect(() => enrollRuntimeTrust(item.input)).toThrow()
  expect(await readFile(join(item.output, 'enrollment.json'))).toEqual(marker)
  expect(inspectRuntimeTrust({ directory: item.output, enrollmentSha256: enrolled.enrollmentSha256 })).toEqual(enrolled)
  const partial = await setup(); await mkdir(partial.output)
  await writeFile(join(partial.output, 'root.json'), await readFile(partial.fixture.rootPath))
  expect(() => enrollRuntimeTrust(partial.input)).toThrow()
  expect(() => inspectRuntimeTrust({ directory: partial.output, enrollmentSha256: enrolled.enrollmentSha256 })).toThrow()
})

test('owned policy survives caller mutation and a valid expired root is only an initial anchor', async () => {
  const item = await setup({ metadataFields: { root: { expires: '2020-01-01T00:00:00Z' } } })
  const enrolled = enrollRuntimeTrust(item.input)
  item.input.minimumReleaseSequence = 1
  item.input.trustedRootSha256 = '0'.repeat(64)
  const checked = inspectRuntimeTrust({ directory: item.output, enrollmentSha256: enrolled.enrollmentSha256 })
  expect(checked.policy.minimumReleaseSequence).toBe(7)
  expect(checked.policy.trustedRootSha256).toBe(item.fixture.rootSha256)
  expect(checked.metadataState).toBe('initial-root-only')
  expect(checked.metadataRefreshPerformed).toBe(false)
  expect(checked.firmwareSelectionPerformed).toBe(false)
})

test('two real processes cannot enroll into the same output', async () => {
  const item = await setup(), worker = join(import.meta.dir, '../fixtures/updates/enroll-worker.ts')
  const processes = [Bun.spawn([process.execPath, worker, JSON.stringify(item.input)], { stdout: 'pipe', stderr: 'pipe', timeout: 20000 }), Bun.spawn([process.execPath, worker, JSON.stringify(item.input)], { stdout: 'pipe', stderr: 'pipe', timeout: 20000 })]
  const results = await Promise.all(processes.map(async child => ({ exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })))
  expect(results.map(r => r.exit).sort()).toEqual([0, 1])
  const success = results.find(r => r.exit === 0)!
  const enrolled = JSON.parse(success.stdout)
  expect(inspectRuntimeTrust({ directory: item.output, enrollmentSha256: enrolled.enrollmentSha256 })).toEqual(enrolled)
  expect(results.find(r => r.exit === 1)!.stdout).toBe('')
}, 60000)

test('an actual child write-limit failure leaves incomplete evidence and preserves the trusted source', async () => {
  const item = await setup(), source = await readFile(item.fixture.rootPath)
  const worker = join(import.meta.dir, '../fixtures/updates/enroll-worker.ts')
  const code = 'import os, resource, signal, sys; signal.signal(signal.SIGXFSZ, signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE, (256,256)); os.execv(sys.argv[1],sys.argv[1:])'
  const failed = spawnSync('python3', ['-c', code, process.execPath, worker, JSON.stringify(item.input)], { timeout: 20000, encoding: 'utf8' })
  expect(failed.error).toBeUndefined()
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain('Trust enrollment rejected')
  expect(await Bun.file(join(item.output, 'enrollment.json')).exists()).toBe(false)
  expect((await stat(join(item.output, 'root.json'))).size).toBe(256)
  expect(await readFile(item.fixture.rootPath)).toEqual(source)
  expect(() => inspectRuntimeTrust({ directory: item.output, enrollmentSha256: '0'.repeat(64) })).toThrow()
  expect(() => enrollRuntimeTrust(item.input)).toThrow()
}, 60000)
