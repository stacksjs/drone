import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, stat, truncate, chmod } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repository, platform, target } from '../fixtures/updates/repository'
import { stageRuntimeFirmware, inspectStagedRuntimeFirmware, type RuntimeFirmwarePolicy } from '../../resources/functions/drone/updates/staging'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('stage and independently reverify an explicitly selected signed runtime image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-update-test-')); roots.push(root)
  const repo = join(root, 'repo'), output = join(root, 'candidate')
  const fixture = await repository(repo)
  const policy = { target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7 } satisfies RuntimeFirmwarePolicy
  const result = await stageRuntimeFirmware({ ...policy, repository: repo, trustedRoot: fixture.rootPath, output })
  expect(result.sha256).toBe(fixture.imageHash)
  expect(result.releaseSequence).toBe(7)
  expect(result.physicalDeploymentAllowed).toBe(false)
  expect(result.trustStatePersisted).toBe(false)
  expect(await readFile(join(output, 'image.bin'))).toEqual(fixture.image)
  expect(await inspectStagedRuntimeFirmware({ ...policy, directory: output })).toEqual(result)
  expect((await stat(output)).mode & 0o777).toBe(0o700)
  expect((await stat(join(output, 'stage.json'))).mode & 0o777).toBe(0o600)
})

async function setup(options: Parameters<typeof repository>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drone-update-test-')); roots.push(root)
  const repo = join(root, 'repo'), output = join(root, 'candidate'), fixture = await repository(repo, options)
  const policy = { target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7 } satisfies RuntimeFirmwarePolicy
  return { root, repo, output, fixture, policy, input: { ...policy, repository: repo, trustedRoot: fixture.rootPath, output } }
}
async function incomplete(output: string) {
  expect(await Bun.file(join(output, 'stage.json')).exists()).toBe(false)
}

test('a root rotation needs signatures from both old and new root authorities', async () => {
  const valid = await setup({ rotate: true })
  expect((await stageRuntimeFirmware(valid.input)).rootVersion).toBe(2)
  expect((await inspectStagedRuntimeFirmware({ ...valid.policy, directory: valid.output })).rootVersion).toBe(2)
  const invalid = await setup({ rotate: true, badRotation: true })
  await expect(stageRuntimeFirmware(invalid.input)).rejects.toThrow()
  await incomplete(invalid.output)
})

test('reject expired metadata and signatures from an unauthorized targets key', async () => {
  for (const options of [{ expires: '2020-01-01T00:00:00Z' }, { badTargetsSignature: true }]) {
    const item = await setup(options)
    await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
    await incomplete(item.output)
  }
})

test('signed platform, protocol, profile and supplied release floor must all match', async () => {
  const rejected: Record<string, string | number | boolean>[] = [{ platform: 'host-neutral-bench-v1' }, { protocolVersion: 2 }, { releaseSequence: 6 }, { releaseSequence: 0 }, { profile: 'flight' }, { sourceRevision: 'not-a-revision' }, { extraAuthority: true }]
  for (const custom of rejected) {
    const item = await setup({ custom })
    await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
    await incomplete(item.output)
  }
})

test('image length/hash and snapshot-bound metadata are verified before the completion marker', async () => {
  const image = await setup()
  await writeFile(image.fixture.imagePath, Buffer.alloc(image.fixture.image.length, 0))
  await expect(stageRuntimeFirmware(image.input)).rejects.toThrow()
  await incomplete(image.output)
  const metadata = await setup()
  const path = join(metadata.repo, 'metadata/1.targets.json'), data = JSON.parse(await readFile(path, 'utf8'))
  data.signed.targets[target].custom.drone.releaseSequence = 99
  await writeFile(path, JSON.stringify(data))
  await expect(stageRuntimeFirmware(metadata.input)).rejects.toThrow()
  await incomplete(metadata.output)
})

test('root pins, target paths and explicit floors cannot be taken from untrusted input', async () => {
  const item = await setup()
  for (const change of [{ trustedRootSha256: '0'.repeat(64) }, { trustedRootSha256: '' }, { minimumReleaseSequence: 0 }, { minimumReleaseSequence: 7.5 }, { minimumReleaseSequence: Number.NaN }, { target: '../root' }, { target: '/runtime/image' }, { target: 'runtime/%2e%2e/image' }, { target: 'runtime\\image' }, { target: 'missing/image.bin' }]) {
    const output = join(item.root, `candidate-${Math.random().toString(16).slice(2)}`)
    await expect(stageRuntimeFirmware({ ...item.input, ...change, output })).rejects.toThrow()
    await incomplete(output)
  }
})

test('an existing output and overlapping source repository are never overwritten', async () => {
  const item = await setup()
  await mkdir(item.output)
  await writeFile(join(item.output, 'keep'), 'untouched')
  await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
  expect(await readFile(join(item.output, 'keep'), 'utf8')).toBe('untouched')
  await expect(stageRuntimeFirmware({ ...item.input, output: join(item.repo, 'inside') })).rejects.toThrow('separate')
  await symlink(item.repo, join(item.root, 'source-link'))
  await expect(stageRuntimeFirmware({ ...item.input, output: join(item.root, 'source-link/inside') })).rejects.toThrow('separate')
})

test('reject source symlinks, devices and over-budget regular files without marking complete', async () => {
  const symlinked = await setup()
  await rm(symlinked.fixture.imagePath)
  await symlink(symlinked.fixture.rootPath, symlinked.fixture.imagePath)
  await expect(stageRuntimeFirmware(symlinked.input)).rejects.toThrow()
  await incomplete(symlinked.output)
  const oversized = await setup()
  await truncate(oversized.fixture.imagePath, 16 * 1024 * 1024 + 1)
  await expect(stageRuntimeFirmware(oversized.input)).rejects.toThrow()
  await incomplete(oversized.output)
  const fifo = await setup()
  await rm(fifo.fixture.imagePath)
  expect(spawnSync('mkfifo', [fifo.fixture.imagePath]).status).toBe(0)
  await expect(stageRuntimeFirmware(fifo.input)).rejects.toThrow()
  await incomplete(fifo.output)
})

test('inspection rejects partial candidates, modified images/receipts and a newly raised floor', async () => {
  const partial = await setup()
  await mkdir(partial.output)
  await writeFile(join(partial.output, 'trust-root.json'), await readFile(partial.fixture.rootPath))
  await expect(inspectStagedRuntimeFirmware({ ...partial.policy, directory: partial.output })).rejects.toThrow()
  const item = await setup()
  const original = await stageRuntimeFirmware(item.input)
  await expect(inspectStagedRuntimeFirmware({ ...item.policy, minimumReleaseSequence: 8, directory: item.output })).rejects.toThrow()
  await expect(inspectStagedRuntimeFirmware({ ...item.policy, target: 'other/image.bin', directory: item.output })).rejects.toThrow()
  await expect(inspectStagedRuntimeFirmware({ ...item.policy, trustedRootSha256: '0'.repeat(64), directory: item.output })).rejects.toThrow()
  await writeFile(join(item.output, 'stage.json'), JSON.stringify({ ...original, physicalDeploymentAllowed: true }))
  await expect(inspectStagedRuntimeFirmware({ ...item.policy, directory: item.output })).rejects.toThrow('receipt')
  await writeFile(join(item.output, 'stage.json'), JSON.stringify(original))
  await writeFile(join(item.output, 'image.bin'), Buffer.alloc(item.fixture.image.length, 0))
  await expect(inspectStagedRuntimeFirmware({ ...item.policy, directory: item.output })).rejects.toThrow()
})

test('concurrent attempts cannot share an output directory', async () => {
  const item = await setup(), attempts = await Promise.allSettled([stageRuntimeFirmware(item.input), stageRuntimeFirmware(item.input)])
  expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter(x => x.status === 'rejected')).toHaveLength(1)
  expect((await inspectStagedRuntimeFirmware({ ...item.policy, directory: item.output })).sha256).toBe(item.fixture.imageHash)
})

test('repository directories writable by other principals cannot enter verification', async () => {
  const item = await setup()
  await chmod(join(item.repo, 'metadata'), 0o777)
  await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
  await incomplete(item.output)
})

test('root, rotated root and delegation key identifiers must bind canonical key data', async () => {
  for (const options of [{ nonCanonicalRoot: true }, { rotate: true, nonCanonicalRotation: true }, { nonCanonicalDelegation: true }]) {
    const item = await setup(options)
    await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
    await incomplete(item.output)
  }
})

test('admission owns the trust policy and inspection directory across asynchronous verification', async () => {
  const stage = await setup(), input = { ...stage.input, minimumReleaseSequence: 8 }
  const pendingStage = stageRuntimeFirmware(input)
  input.minimumReleaseSequence = 7
  await expect(pendingStage).rejects.toThrow('minimum release sequence')
  await incomplete(stage.output)
  const item = await setup(), accepted = await stageRuntimeFirmware(item.input)
  const raised = { ...item.policy, directory: item.output, minimumReleaseSequence: 8 }
  const pendingInspect = inspectStagedRuntimeFirmware(raised)
  raised.minimumReleaseSequence = 7
  await expect(pendingInspect).rejects.toThrow('minimum release sequence')
  const stable = { ...item.policy, directory: item.output }
  const pendingStable = inspectStagedRuntimeFirmware(stable)
  stable.directory = join(item.root, 'does-not-exist')
  stable.trustedRootSha256 = '0'.repeat(64)
  stable.target = 'other/image.bin'
  expect(await pendingStable).toEqual(accepted)
}, 60000)


test('reject malformed or normalized expiration dates instead of treating them as unexpired', async () => {
  for (const expires of ['not-a-date', '2035-02-30T00:00:00Z', '2035-01-01', '2035-01-01T00:00:00+01:00']) {
    const item = await setup({ expires })
    await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
    await incomplete(item.output)
  }
})

test('the bootstrap root and every fetched metadata role require valid expiration dates', async () => {
  for (const role of ['root', 'rotatedRoot', 'snapshot', 'targets'] as const) {
    const item = await setup({ rotate: role === 'rotatedRoot', metadataFields: { [role]: { expires: 'not-a-date' } } })
    await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
    await incomplete(item.output)
  }
})

test('metadata versions must be positive safe integers', async () => {
  for (const role of ['root', 'timestamp'] as const) {
    for (const version of [0, -1, 9007199254740992]) {
      const item = await setup({ metadataFields: { [role]: { version } } })
      await expect(stageRuntimeFirmware(item.input)).rejects.toThrow()
      await incomplete(item.output)
    }
  }
})


test('a valid UTC leap date remains accepted and independently verifiable', async () => {
  const item = await setup({ expires: '2036-02-29T12:34:56Z' })
  const staged = await stageRuntimeFirmware(item.input)
  expect(await inspectStagedRuntimeFirmware({ ...item.policy, directory: item.output })).toEqual(staged)
})
