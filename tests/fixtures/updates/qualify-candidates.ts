import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { platform, repository, target } from './repository'

async function hash(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex') }

/** Real copied commands, signed synthetic bytes and optional retained format-1-only binary. Never executes a candidate. */
export async function qualifyPortableCandidates(directory: string, source: string, olderBinary?: string) {
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), sourceSha256 = await hash(source)
  await copyFile(source, binary, constants.COPYFILE_EXCL); await chmod(binary, 0o700)
  assert.equal(await hash(binary), sourceSha256); assert.equal(await hash(source), sourceSha256)
  const olderSha256 = olderBinary ? await hash(olderBinary) : null
  const repo = join(directory, 'repo'), fixture = await repository(repo, { rotate: true, custom: { releaseSequence: 9 } })
  const enrollment = join(directory, 'enrollment'), store = join(directory, 'store')
  const results: { command: string, binarySha256: string, exit: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected = 0, executable = binary) {
    const child = Bun.spawn([executable, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      results.push({ command: args[0]!, binarySha256: executable === binary ? sourceSha256 : olderSha256!, exit, stdout, stderr }); assert.equal(exit, expected)
      if (expected) { assert.equal(stdout, ''); assert.equal(stderr, 'Runtime update store unavailable: invalid trust, clock, state or storage failure\n') }
      return stdout ? JSON.parse(stdout) : undefined
    }
    finally { clearTimeout(timer) }
  }
  try {
    const enrolled = await run(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', enrollment, '--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7'])
    const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256]
    const created = await run(['updates:store-init', ...flags, '--output', store])
    const pinned = [...flags, '--store-sha256', created.storeSha256]
    const repositoryFlags = ['--repository', repo, '--trusted-system-clock-source', 'operator-managed-test-clock']
    const initialHash = await hash(join(store, 'state.sqlite'))
    const empty = await run(['updates:candidates', store, ...pinned])
    assert.equal(empty.stateFormat, 1); assert.equal(empty.candidate, null)
    assert.equal(await hash(join(store, 'state.sqlite')), initialHash)
    if (olderBinary) {
      // A format-1 predecessor cannot emit the later, empty maintenance status field.
      const { maintenanceHandoffs, ...format1Status } = created
      assert.deepEqual(maintenanceHandoffs, [])
      assert.deepEqual(await run(['updates:store', store, ...pinned], 0, olderBinary), format1Status)
      assert.equal(await hash(join(store, 'state.sqlite')), initialHash)
    }
    await run(['updates:reserve', store, ...pinned, '--repository', repo], 1)
    const prepared = await run(['updates:reserve', store, ...pinned, ...repositoryFlags])
    assert.equal(prepared.stateFormat, 2); assert.equal(prepared.store.releaseFloor, 9)
    assert.equal(prepared.store.attempt.phase, 'verified'); assert.equal(prepared.store.metadata.find((row: { role: string }) => row.role === 'root').version, 2)
    assert.equal(prepared.candidate.phase, 'prepared'); assert.equal(prepared.candidate.integrity, 'recorded-bytes-match')
    assert.equal(prepared.candidate.description.sha256, fixture.imageHash); assert.equal(prepared.candidate.currentTrustValidated, false); assert.equal(prepared.physicalDeploymentAllowed, false)
    assert.deepEqual(await run(['updates:candidates', store, ...pinned]), prepared)
    await run(['updates:reserve', store, ...pinned, ...repositoryFlags], 1)
    await run(['updates:retire', store, ...pinned, '--candidate', '0'.repeat(32)], 1)
    assert.deepEqual(await run(['updates:candidates', store, ...pinned]), prepared)
    if (olderBinary) {
      const stateHash = await hash(join(store, 'state.sqlite')), writerHash = await hash(join(store, 'writer.sqlite'))
      await run(['updates:store', store, ...pinned], 1, olderBinary)
      assert.equal(await hash(join(store, 'state.sqlite')), stateHash); assert.equal(await hash(join(store, 'writer.sqlite')), writerHash)
      assert.equal(await hash(olderBinary), olderSha256)
    }
    await run(['updates:candidates', store, ...flags, '--store-sha256', '0'.repeat(64)], 1)
    const original = await readFile(join(prepared.candidate.directory, 'stage.json'))
    await writeFile(join(prepared.candidate.directory, 'image.bin'), Buffer.alloc(fixture.image.length, 0xff))
    const damaged = await run(['updates:candidates', store, ...pinned])
    assert.equal(damaged.candidate.integrity, 'mismatch'); assert.equal(damaged.candidate.currentTrustValidated, false)
    await writeFile(join(prepared.candidate.directory, 'image.bin'), fixture.image)
    const retired = await run(['updates:retire', store, ...pinned, '--candidate', prepared.candidate.id])
    assert.equal(retired.candidate, null); assert.equal(retired.retainedCandidates, 1); assert.equal(retired.store.releaseFloor, 9)
    assert.deepEqual(await readFile(join(prepared.candidate.directory, 'stage.json')), original)
    await writeFile(fixture.imagePath, Buffer.alloc(fixture.image.length, 0xff))
    await run(['updates:reserve', store, ...pinned, ...repositoryFlags], 1)
    const stopped = await run(['updates:candidates', store, ...pinned])
    assert.equal(stopped.candidate.phase, 'reserved'); assert.equal(stopped.candidate.integrity, 'incomplete')
    assert.equal(stopped.store.releaseFloor, 9); assert.equal(stopped.store.attempt.phase, 'maintenance')
    await run(['updates:recover', store, ...pinned])
    const recovered = await run(['updates:candidates', store, ...pinned])
    assert.deepEqual(recovered.candidate, stopped.candidate); assert.equal(recovered.store.releaseFloor, 9)
    await run(['updates:retire', store, ...pinned, '--candidate', stopped.candidate.id])
    await writeFile(fixture.imagePath, fixture.image)
    const fresh = await run(['updates:reserve', store, ...pinned, ...repositoryFlags])
    assert.equal(fresh.retainedCandidates, 3); assert.notEqual(fresh.candidate.id, prepared.candidate.id)
    assert.equal(fresh.candidate.integrity, 'recorded-bytes-match'); assert.equal(fresh.store.releaseFloor, 9)
    assert.equal(fresh.candidate.currentTrustValidated, false); assert.equal(fresh.physicalDeploymentAllowed, false)
    assert.deepEqual(await readFile(join(prepared.candidate.directory, 'image.bin')), fixture.image)
    assert.deepEqual(await readFile(join(prepared.candidate.directory, 'stage.json')), original)
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'copied-standalone-owned-candidates-v1', sourceSha256, olderSha256, results, physicalDeploymentAllowed: false }, null, 2)) }
  return { evidence: 'copied-standalone-owned-candidates-v1', operations: results.length, sourceSha256, olderSha256, physicalDeploymentAllowed: false }
}
if (import.meta.main) {
  if (process.argv.length !== 4 && process.argv.length !== 5) throw new Error('Use qualify-candidates.ts NEW_DIRECTORY COMPILED_BINARY [FORMAT1_BINARY]')
  console.log(JSON.stringify(await qualifyPortableCandidates(resolve(process.argv[2]!), resolve(process.argv[3]!), process.argv[4] ? resolve(process.argv[4]) : undefined)))
}
