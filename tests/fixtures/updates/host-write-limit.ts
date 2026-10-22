import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { buildRuntime } from '../../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeFirmwareSlots, recoverRuntimeTrustStore, reserveRuntimeFirmwareCandidate, trialRuntimeFirmwareCandidate } from '../../../resources/functions/drone/updates/store'
import { runBoundedHostProcess } from '../../../resources/functions/host/process'
import { createHostSourceProject } from './host-project'
import { digest, repository, target } from './repository'

const fileLimitBytes = 1048576
const clock = { source: 'independent-resource-fixture-clock', read: () => new Date('2030-01-01T00:00:00Z') }

function errorCodes(error: unknown) {
  const pending = [error], seen = new Set<unknown>(), codes: string[] = []
  while (pending.length && seen.size < 32) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    const code = Object.getOwnPropertyDescriptor(item, 'code')?.value
    if ((typeof code === 'string' || typeof code === 'number') && String(code).length <= 64) codes.push(String(code))
    const cause = Object.getOwnPropertyDescriptor(item, 'cause')?.value
    if (cause !== undefined) pending.push(cause)
    const errors = Object.getOwnPropertyDescriptor(item, 'errors')?.value
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 32))
  }
  return codes
}

async function fixtureInput(inputPath: string) {
  assert.equal(basename(inputPath), 'worker-input.json')
  const root = dirname(resolve(inputPath))
  const input = await Bun.file(inputPath).json()
  const marker = await Bun.file(join(root, 'fixture.json')).json()
  assert.equal(marker.kind, 'host-file-write-limit-v1'); assert.equal(input.nonce, marker.nonce)
  assert.match(input.nonce, /^[a-f0-9]{32}$/)
  assert.equal(input.reference.directory, join(root, 'store'))
  assert.equal(input.reference.enrollmentDirectory, join(root, 'enrollment'))
  assert.equal(input.project, join(root, 'project')); assert.equal(input.repository, join(root, 'repository'))
  return input
}

async function limitedTrial(inputPath: string) {
  assert.equal(process.env.DRONE_TEST_FILE_LIMIT, String(fileLimitBytes))
  const input = await fixtureInput(inputPath)
  const phases: string[] = []
  let caught = false, codes: string[] = []
  try {
    await trialRuntimeFirmwareCandidate({ ...input.reference, repository: input.repository, project: input.project, candidateId: input.candidateId, clock, onProgress(event) {
      assert.ok(phases.length < 512); phases.push(event.phase)
    } })
  }
  catch (error) { caught = true; codes = errorCodes(error) }
  assert.equal(caught, true, 'The actual kernel file limit must reject the trial')
  return { errorCodes: codes, phases }
}

/** Real signed public coordinator, actual short OS write, retained bytes and fresh recovery. */
export async function qualifyHostFileWriteLimit(directory: string) {
  directory = resolve(directory)
  await mkdir(directory, { mode: 0o700 })
  const nonce = randomBytes(16).toString('hex')
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ kind: 'host-file-write-limit-v1', nonce }), { mode: 0o600 })
  const launcher = join(directory, 'file-write-limit')
  const compiled = await runBoundedHostProcess(['c++', '-std=c++17', '-O2', join(import.meta.dir, 'file-write-limit.cpp'), '-o', launcher], { timeoutMs: 10000, stdoutBytes: 16384, stderrBytes: 16384, label: 'Host file-limit launcher build' })
  assert.equal(compiled.exitCode, 0, compiled.stderr)
  const { project, sourceRevision } = await createHostSourceProject(directory, { imagePadding: true })
  const built = await buildRuntime({ project }), image = await readFile(built.artifact)
  assert.ok(image.length > fileLimitBytes && image.length < 4 * fileLimitBytes)
  const source = join(directory, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
  const enrollmentDirectory = join(directory, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
  const store = join(directory, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: store })
  const reference = { directory: store, enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
  const first = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
  const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: first.candidate!.id })
  assert.equal(good.knownGood!.description.releaseSequence, 7)
  await signed.publish({ image, version: 2, custom: { releaseSequence: 9 } })
  const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
  assert.equal(next.store.releaseFloor, 9)
  await signed.publish({ image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
  const config = join(directory, 'worker.bunfig.toml'), input = join(directory, 'worker-input.json')
  await writeFile(config, 'preload=[]\n', { mode: 0o600 })
  await writeFile(input, JSON.stringify({ nonce, reference, project, repository: source, candidateId: next.candidate!.id }), { mode: 0o600 })
  const workerEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }
  const command = [launcher, String(fileLimitBytes), process.execPath, '--no-env-file', `--config=${config}`, import.meta.path, 'limited', input]
  const worker = await runBoundedHostProcess(command, { cwd: directory, env: workerEnv, timeoutMs: 60000, stdoutBytes: 16384, stderrBytes: 16384, label: 'Actual host image short-write trial' })
  await writeFile(join(directory, 'worker.stdout'), worker.stdout)
  await writeFile(join(directory, 'worker.stderr'), worker.stderr)
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ exitCode: worker.exitCode }))
  assert.equal(worker.exitCode, 0, worker.stderr)
  assert.equal(worker.stderr, `FILE_LIMIT_ACTIVE ${fileLimitBytes}\n`)
  const rejected = JSON.parse(worker.stdout)
  assert.ok(Array.isArray(rejected.errorCodes) && rejected.errorCodes.length <= 32 && rejected.errorCodes.every((code: unknown) => typeof code === 'string' && code.length <= 64) && rejected.errorCodes.includes('EFBIG'))
  assert.ok(Array.isArray(rejected.phases) && rejected.phases.length <= 512 && rejected.phases.every((phase: unknown) => typeof phase === 'string' && phase.length <= 64))
  assert.ok(rejected.phases.includes('slot-selected'))
  assert.ok(!rejected.phases.includes('slot-image-written') && !rejected.phases.includes('runtime-started') && !rejected.phases.includes('runtime-input-committed'))
  const failed = await inspectRuntimeFirmwareSlots(reference)
  await writeFile(join(directory, 'failed-slots.json'), JSON.stringify(failed, null, 2))
  assert.deepEqual(failed.knownGood, good.knownGood); assert.deepEqual(failed.installed, good.installed)
  assert.equal(failed.trial!.phase, 'failed'); assert.equal(failed.trial!.health, null)
  assert.equal(failed.trial!.integrity, 'mismatch'); assert.equal(failed.store.attempt!.phase, 'maintenance')
  assert.equal(failed.store.releaseFloor, 9)
  const version = (role: string) => failed.store.metadata.find(row => row.role === role)!.version
  assert.equal(version('root'), 2); assert.equal(version('targets'), 3)
  const partialPath = join(store, 'host-slots', failed.trial!.id, 'image.bin'), partial = await readFile(partialPath)
  assert.equal(partial.length, fileLimitBytes); assert.deepEqual(partial, image.subarray(0, fileLimitBytes))
  const oldImage = join(store, 'host-slots', good.knownGood!.id, 'image.bin')
  assert.deepEqual(await readFile(oldImage), image)
  async function unrestricted(mode: 'recover' | 'fresh') {
    const result = await runBoundedHostProcess([process.execPath, '--no-env-file', `--config=${config}`, import.meta.path, mode, input], { cwd: directory, env: { ...workerEnv, DRONE_TEST_FILE_LIMIT: undefined }, timeoutMs: 60000, stdoutBytes: 16384, stderrBytes: 16384, label: `Fresh host write-limit ${mode}` })
    await writeFile(join(directory, `${mode}.stdout`), result.stdout)
    await writeFile(join(directory, `${mode}.stderr`), result.stderr)
    await writeFile(join(directory, `${mode}.json`), JSON.stringify({ exitCode: result.exitCode }))
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, `${mode === 'recover' ? 'RECOVERY_COMPLETED' : 'FRESH_TRIAL_COMPLETED'}\n`)
  }
  await unrestricted('recover')
  const recovered = await inspectRuntimeFirmwareSlots(reference)
  await writeFile(join(directory, 'recovered-slots.json'), JSON.stringify(recovered, null, 2))
  assert.deepEqual(recovered.trial, failed.trial); assert.deepEqual(recovered.knownGood, good.knownGood)
  assert.equal(recovered.store.releaseFloor, 9)
  assert.deepEqual(recovered.store.metadata, failed.store.metadata)
  await unrestricted('fresh')
  const fresh = await inspectRuntimeFirmwareSlots(reference)
  await writeFile(join(directory, 'confirmed-slots.json'), JSON.stringify(fresh, null, 2))
  assert.notEqual(fresh.knownGood!.id, failed.trial!.id)
  assert.equal(fresh.knownGood!.description.releaseSequence, 9)
  assert.equal(fresh.knownGood!.health!.cleanProcessExit, true)
  assert.notEqual(fresh.knownGood!.health!.bootId, good.knownGood!.health!.bootId)
  assert.notEqual(fresh.knownGood!.health!.sessionId, good.knownGood!.health!.sessionId)
  assert.deepEqual(await readFile(oldImage), image); assert.deepEqual(await readFile(partialPath), partial)
  assert.deepEqual(await readFile(join(store, 'host-slots', fresh.knownGood!.id, 'image.bin')), image)
  const result = { evidence: 'host-slot-actual-short-write-v1', sourceRevision, authorizedImageSha256: signed.imageHash, fileLimitBytes, partialImageBytes: partial.length, partialImageSha256: digest(partial), authorizedImageBytes: image.length, errorCodes: rejected.errorCodes as string[], acceptedRootVersion: version('root'), acceptedTargetsVersion: version('targets'), releaseFloor: fresh.store.releaseFloor, previousSlotId: good.knownGood!.id, failedSlotId: failed.trial!.id, confirmedSlotId: fresh.knownGood!.id, previousBootId: good.knownGood!.health!.bootId, freshBootId: fresh.knownGood!.health!.bootId, physicalDeploymentAllowed: fresh.physicalDeploymentAllowed }
  await writeFile(join(directory, 'qualification.json'), JSON.stringify(result, null, 2))
  return result
}

if (import.meta.main) {
  try {
    assert.equal(process.argv.length, 4)
    const mode = process.argv[2], inputPath = resolve(process.argv[3]!)
    if (mode === 'limited') console.log(JSON.stringify(await limitedTrial(inputPath)))
    else if (mode === 'recover' || mode === 'fresh') {
      assert.equal(process.env.DRONE_TEST_FILE_LIMIT, undefined)
      const input = await fixtureInput(inputPath)
      if (mode === 'recover') { await recoverRuntimeTrustStore(input.reference); console.log('RECOVERY_COMPLETED') }
      else { await trialRuntimeFirmwareCandidate({ ...input.reference, repository: input.repository, project: input.project, candidateId: input.candidateId, clock }); console.log('FRESH_TRIAL_COMPLETED') }
    }
    else { assert.equal(mode, 'qualify'); console.log(JSON.stringify(await qualifyHostFileWriteLimit(inputPath))) }
  }
  catch (error) { console.error('Host file-limit fixture failed', error); process.exitCode = 1 }
}
