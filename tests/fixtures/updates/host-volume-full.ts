import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, statfsSync, writeSync } from 'node:fs'
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { buildRuntime } from '../../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { abandonRuntimeFirmwareTrial, createRuntimeTrustStore, inspectRuntimeFirmwareSlots, recoverRuntimeTrustStore, reserveRuntimeFirmwareCandidate, trialRuntimeFirmwareCandidate } from '../../../resources/functions/drone/updates/store'
import { runBoundedHostProcess } from '../../../resources/functions/host/process'
import { createHostSourceProject } from './host-project'
import { digest, repository, target } from './repository'
import { storageErrorCodes } from './storage-errors'

const volumeBytes = 16777216, reserveBytes = 1048576
const clock = { source: 'independent-full-volume-fixture-clock', read: () => new Date('2030-01-01T00:00:00Z') }

function privateNamespace() {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.RUNTIME_HOST_ENOSPC_TEST, '1')
  assert.equal(process.getuid?.(), 0)
  const current = readlinkSync('/proc/self/ns/mnt')
  assert.notEqual(current, readlinkSync('/proc/1/ns/mnt'), 'Use an actual private mount namespace')
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
  assert.ok(mounts.length > 0 && mounts.length < 2097152)
  for (const line of mounts.trim().split('\n')) {
    const [fields, filesystem] = line.split(' - ')
    assert.ok(fields && filesystem)
    assert.ok(!fields.split(' ').slice(6).some(field => /^(shared|master|propagate_from):/.test(field)), 'Require recursively private mount propagation before creating a filesystem')
  }
  return current
}

function checkedVolume(volume: string) {
  const identity = lstatSync(volume), stats = statfsSync(volume)
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink() && identity.uid === process.getuid?.() && (identity.mode & 0o777) === 0o700)
  assert.equal(stats.type, 0x01021994, 'Require actual Linux tmpfs')
  assert.ok(stats.bsize >= 4096 && stats.bsize <= 65536 && reserveBytes % stats.bsize === 0)
  assert.equal(stats.blocks * stats.bsize, volumeBytes)
  return { device: identity.dev, blockBytes: stats.bsize, capacityBytes: stats.blocks * stats.bsize, freeBytes: stats.bfree * stats.bsize }
}

function object(value: unknown) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function text(value: unknown) { assert.equal(typeof value, 'string'); return value as string }
function identity(value: unknown, length: 32 | 64) { const result = text(value); assert.match(result, new RegExp(`^[a-f0-9]{${length}}$`)); return result }

async function workerInput(path: string) {
  const namespace = privateNamespace(), root = dirname(resolve(path)), volume = join(root, 'volume')
  assert.equal(basename(path), 'worker-input.json')
  const item = object(await Bun.file(path).json()), marker = object(await Bun.file(join(root, 'fixture.json')).json())
  assert.equal(marker.kind, 'host-full-volume-v1'); assert.equal(item.nonce, marker.nonce)
  assert.equal(item.namespace, namespace); identity(item.nonce, 32)
  assert.equal(readFileSync(join(volume, 'nonce'), 'utf8'), item.nonce)
  checkedVolume(volume)
  const reference = object(item.reference)
  assert.equal(reference.directory, join(volume, 'store')); assert.equal(reference.enrollmentDirectory, join(root, 'enrollment'))
  assert.equal(item.project, join(root, 'project')); assert.equal(item.repository, join(root, 'repository'))
  return { root, volume, project: text(item.project), repository: text(item.repository), candidateId: identity(item.candidateId, 32), trialId: item.trialId === undefined ? undefined : identity(item.trialId, 32), reference: {
    directory: text(reference.directory), enrollmentDirectory: text(reference.enrollmentDirectory), enrollmentSha256: identity(reference.enrollmentSha256, 64), storeSha256: identity(reference.storeSha256, 64),
  } }
}

function fillVolume(volume: string) {
  const before = checkedVolume(volume), path = join(volume, 'filler.bin')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let written = 0, full = false
  try {
    const bytes = Buffer.alloc(65536, 0xa5)
    while (written <= volumeBytes) {
      try { const count = writeSync(fd, bytes); assert.ok(count > 0); written += count }
      catch (error) { assert.ok(storageErrorCodes(error).includes('ENOSPC')); full = true; break }
    }
    assert.equal(full, true); assert.equal(checkedVolume(volume).freeBytes, 0)
    assert.ok(written > reserveBytes); ftruncateSync(fd, written - reserveBytes)
    const after = checkedVolume(volume)
    assert.equal(after.freeBytes, reserveBytes); assert.equal(after.device, before.device)
    return { before, after, written, fillerBytes: written - reserveBytes, fillError: 'ENOSPC' }
  }
  finally { closeSync(fd) }
}

async function limited(inputPath: string) {
  const input = await workerInput(inputPath), phases: string[] = []
  let rejected = false, codes: string[] = []
  try {
    await trialRuntimeFirmwareCandidate({ ...input.reference, repository: input.repository, project: input.project, candidateId: input.candidateId, clock, async onProgress(event) {
      assert.ok(phases.length < 512); phases.push(event.phase)
      if (event.phase === 'slot-selected') await writeFile(join(input.root, 'fill.json'), JSON.stringify(fillVolume(input.volume), null, 2))
    } })
  }
  catch (error) { rejected = true; codes = storageErrorCodes(error) }
  assert.equal(rejected, true, 'Actual filesystem exhaustion must reject confirmation')
  return { errorCodes: codes, phases, volumeAfterFailure: checkedVolume(input.volume) }
}

function volumeFiles(root: string) {
  const records: { path: string, byteLength: number, sha256: string }[] = []
  let total = 0
  function walk(path: string, relative: string) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), next = relative ? `${relative}/${name}` : name, stat = lstatSync(child)
      assert.ok(!stat.isSymbolicLink())
      if (stat.isDirectory()) walk(child, next)
      else {
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= volumeBytes)
        assert.ok(records.length < 512); total += stat.size; assert.ok(total <= volumeBytes)
        records.push({ path: next, byteLength: stat.size, sha256: digest(readFileSync(child)) })
      }
    }
  }
  walk(root, '')
  return records
}

async function archiveVolume(volume: string, output: string) {
  const before = volumeFiles(volume)
  await cp(volume, output, { recursive: true, errorOnExist: true, force: false })
  assert.deepEqual(volumeFiles(output), before)
  await writeFile(`${output}.json`, JSON.stringify(before, null, 2))
}

/** Full bounded tmpfs, genuine ENOSPC/SQLite failure, and fresh public recovery. */
export async function qualifyHostFullVolume(directory: string) {
  const namespace = privateNamespace()
  directory = resolve(directory)
  await mkdir(directory, { mode: 0o700 })
  const volume = join(directory, 'volume'), nonce = randomBytes(16).toString('hex')
  await mkdir(volume, { mode: 0o700 })
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ kind: 'host-full-volume-v1', nonce, namespace }), { mode: 0o600 })
  async function command(argv: string[], label: string, timeoutMs = 10000) {
    const result = await runBoundedHostProcess(argv, { cwd: directory, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, timeoutMs, stdoutBytes: 16384, stderrBytes: 16384, label })
    assert.equal(result.exitCode, 0, result.stderr)
    return result
  }
  await command(['mount', '--no-mtab', '-t', 'tmpfs', '-o', `size=${volumeBytes},mode=0700,nosuid,nodev,noexec`, 'drone-runtime-test', volume], 'Private bounded update filesystem mount')
  try {
    const mounted = checkedVolume(volume)
    assert.notEqual(mounted.device, lstatSync(directory).dev)
    await writeFile(join(volume, 'nonce'), nonce, { mode: 0o600 })
    const { project, sourceRevision } = await createHostSourceProject(directory, { imagePadding: true })
    const built = await buildRuntime({ project }), image = await readFile(built.artifact)
    assert.ok(image.length > reserveBytes && image.length < 4 * reserveBytes)
    const source = join(directory, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(directory, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(volume, 'store') })
    const reference = { directory: join(volume, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
    const first = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: first.candidate!.id })
    assert.equal(good.knownGood!.description.releaseSequence, 7)
    await signed.publish({ image, version: 2, custom: { releaseSequence: 9 } })
    const candidate = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    await signed.publish({ image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    const inputPath = join(directory, 'worker-input.json'), config = join(directory, 'worker.bunfig.toml')
    const input = { nonce, namespace, reference, project, repository: source, candidateId: candidate.candidate!.id }
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 }); await writeFile(config, 'preload=[]\n', { mode: 0o600 })
    async function worker(mode: 'limited' | 'recover' | 'abandon' | 'fresh') {
      const result = await runBoundedHostProcess([process.execPath, '--no-env-file', `--config=${config}`, import.meta.path, mode, inputPath], { cwd: directory, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, timeoutMs: 60000, stdoutBytes: 16384, stderrBytes: 16384, label: `Full update filesystem ${mode}` })
      await writeFile(join(directory, `${mode}.stdout`), result.stdout)
      await writeFile(join(directory, `${mode}.stderr`), result.stderr)
      await writeFile(join(directory, `${mode}.json`), JSON.stringify({ exitCode: result.exitCode }))
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stderr, '')
      return result.stdout
    }
    const rejection = object(JSON.parse(await worker('limited')))
    assert.ok(Array.isArray(rejection.errorCodes) && rejection.errorCodes.every(code => typeof code === 'string' && code.length <= 64) && rejection.errorCodes.length <= 32)
    assert.ok(rejection.errorCodes.includes('ENOSPC') && rejection.errorCodes.includes('SQLITE_FULL'))
    assert.ok(Array.isArray(rejection.phases) && rejection.phases.includes('slot-selected'))
    assert.ok(!rejection.phases.includes('slot-image-written') && !rejection.phases.includes('runtime-started') && !rejection.phases.includes('runtime-input-committed'))
    const fullVolume = checkedVolume(volume)
    assert.equal(fullVolume.freeBytes, 0)
    await writeFile(join(directory, 'full-filesystem.json'), JSON.stringify(fullVolume, null, 2))
    await archiveVolume(volume, join(directory, 'full-volume'))
    await unlink(join(volume, 'filler.bin'))
    const failed = await inspectRuntimeFirmwareSlots(reference)
    await writeFile(join(directory, 'failed-slots.json'), JSON.stringify(failed, null, 2))
    assert.deepEqual(failed.knownGood, good.knownGood); assert.deepEqual(failed.installed, good.installed)
    assert.equal(failed.trial!.phase, 'selected'); assert.equal(failed.trial!.health, null)
    assert.equal(failed.trial!.integrity, 'mismatch'); assert.equal(failed.store.attempt!.phase, 'pending')
    assert.equal(failed.store.releaseFloor, 9)
    const version = (role: string) => failed.store.metadata.find(row => row.role === role)!.version
    assert.equal(version('root'), 2); assert.equal(version('targets'), 3)
    const partialPath = join(reference.directory, 'host-slots', failed.trial!.id, 'image.bin'), partial = await readFile(partialPath)
    assert.ok(partial.length > 0 && partial.length < image.length); assert.deepEqual(partial, image.subarray(0, partial.length))
    const previousImage = join(reference.directory, 'host-slots', good.knownGood!.id, 'image.bin')
    assert.deepEqual(await readFile(previousImage), image)
    await archiveVolume(volume, join(directory, 'failed-volume'))
    await assert.rejects(abandonRuntimeFirmwareTrial({ ...reference, trialId: failed.trial!.id }), /Resolve metadata/)
    await writeFile(inputPath, JSON.stringify({ ...input, trialId: failed.trial!.id }))
    assert.equal(await worker('recover'), 'RECOVERY_COMPLETED\n')
    const recovered = await inspectRuntimeFirmwareSlots(reference)
    await writeFile(join(directory, 'recovered-slots.json'), JSON.stringify(recovered, null, 2))
    assert.deepEqual(recovered.trial, failed.trial); assert.deepEqual(recovered.knownGood, good.knownGood)
    assert.equal(recovered.store.attempt!.phase, 'recovered'); assert.equal(recovered.store.releaseFloor, 9)
    assert.deepEqual(recovered.store.metadata, failed.store.metadata)
    assert.equal(await worker('abandon'), 'ABANDON_COMPLETED\n')
    const abandoned = await inspectRuntimeFirmwareSlots(reference)
    await writeFile(join(directory, 'abandoned-slots.json'), JSON.stringify(abandoned, null, 2))
    assert.equal(abandoned.trial!.phase, 'abandoned'); assert.equal(abandoned.trial!.health, null)
    assert.deepEqual(abandoned.knownGood, good.knownGood)
    assert.equal(await worker('fresh'), 'FRESH_TRIAL_COMPLETED\n')
    const fresh = await inspectRuntimeFirmwareSlots(reference)
    await writeFile(join(directory, 'confirmed-slots.json'), JSON.stringify(fresh, null, 2))
    assert.equal(fresh.knownGood!.description.releaseSequence, 9); assert.equal(fresh.knownGood!.health!.cleanProcessExit, true)
    assert.notEqual(fresh.knownGood!.id, failed.trial!.id)
    assert.notEqual(fresh.knownGood!.health!.bootId, good.knownGood!.health!.bootId)
    assert.notEqual(fresh.knownGood!.health!.sessionId, good.knownGood!.health!.sessionId)
    assert.deepEqual(await readFile(partialPath), partial); assert.deepEqual(await readFile(previousImage), image)
    assert.deepEqual(await readFile(join(reference.directory, 'host-slots', fresh.knownGood!.id, 'image.bin')), image)
    const result = { evidence: 'host-actual-enospc-v1', filesystemType: 'tmpfs', filesystemBytes: mounted.capacityBytes, freeBytesAfterFailure: fullVolume.freeBytes, sourceRevision, authorizedImageBytes: image.length, authorizedImageSha256: signed.imageHash, partialImageBytes: partial.length, partialImageSha256: digest(partial), errorCodes: rejection.errorCodes, interruptedPhase: failed.trial!.phase, interruptedAttempt: failed.store.attempt!.phase, acceptedRootVersion: version('root'), acceptedTargetsVersion: version('targets'), releaseFloor: fresh.store.releaseFloor, abandonedPhase: abandoned.trial!.phase, previousSlotId: good.knownGood!.id, failedSlotId: failed.trial!.id, confirmedSlotId: fresh.knownGood!.id, previousBootId: good.knownGood!.health!.bootId, freshBootId: fresh.knownGood!.health!.bootId, physicalDeploymentAllowed: fresh.physicalDeploymentAllowed }
    await writeFile(join(directory, 'qualification.json'), JSON.stringify(result, null, 2))
    return result
  }
  finally {
    try { await archiveVolume(volume, join(directory, 'final-volume')) }
    finally { await command(['umount', '--no-mtab', volume], 'Private bounded update filesystem unmount') }
  }
}

if (import.meta.main) {
  try {
    assert.equal(process.argv.length, 4)
    const mode = process.argv[2], path = resolve(process.argv[3]!)
    if (mode === 'qualify') console.log(JSON.stringify(await qualifyHostFullVolume(path)))
    else if (mode === 'limited') console.log(JSON.stringify(await limited(path)))
    else {
      const input = await workerInput(path)
      if (mode === 'recover') { await recoverRuntimeTrustStore(input.reference); console.log('RECOVERY_COMPLETED') }
      else if (mode === 'abandon') { assert.ok(input.trialId); await abandonRuntimeFirmwareTrial({ ...input.reference, trialId: input.trialId }); console.log('ABANDON_COMPLETED') }
      else { assert.equal(mode, 'fresh'); await trialRuntimeFirmwareCandidate({ ...input.reference, repository: input.repository, project: input.project, candidateId: input.candidateId, clock }); console.log('FRESH_TRIAL_COMPLETED') }
    }
  }
  catch (error) { console.error('Host full-volume fixture failed', error); process.exitCode = 1 }
}
