import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { platform, repository, target } from './repository'

async function hash(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex') }

/** Exercise actual copied standalone commands. Signed payloads are synthetic and are never executed. */
export async function qualifyPortablePreparation(directory: string, source: string) {
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), sourceSha256 = await hash(source)
  await copyFile(source, binary, constants.COPYFILE_EXCL); await chmod(binary, 0o700)
  assert.equal(await hash(binary), sourceSha256); assert.equal(await hash(source), sourceSha256)
  const repo = join(directory, 'repo'), fixture = await repository(repo, { rotate: true, custom: { releaseSequence: 9 } })
  const enrollment = join(directory, 'enrollment'), store = join(directory, 'store'), output = join(directory, 'candidate')
  const results: { command: string, exit: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected = 0) {
    const child = Bun.spawn([binary, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      results.push({ command: args[0]!, exit, stdout, stderr }); assert.equal(exit, expected)
      if (expected) { assert.equal(stdout, ''); assert.equal(stderr, 'Runtime image preparation unavailable: invalid trust, clock, rejected image or output failure\n') }
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
    await run(['updates:prepare', store, ...pinned, '--repository', repo, '--output', join(directory, 'missing-clock')], 1)
    const prepared = await run(['updates:prepare', store, ...pinned, ...repositoryFlags, '--output', output])
    assert.equal(prepared.store.releaseFloor, 9); assert.equal(prepared.store.attempt.phase, 'verified')
    assert.equal(prepared.candidate.sha256, fixture.imageHash); assert.equal(prepared.trustStatePersisted, true); assert.equal(prepared.physicalDeploymentAllowed, false)
    const root = prepared.store.metadata.find((row: { role: string }) => row.role === 'root')
    assert.equal(root.version, 2); assert.equal(prepared.candidate.trustedRootSha256, root.sha256)
    assert.deepEqual(await run(['updates:inspect', output, '--target', target, '--platform', platform, '--root-sha256', root.sha256, '--minimum-release-sequence', '9']), prepared.candidate)
    await writeFile(fixture.imagePath, Buffer.alloc(fixture.image.length, 0xff))
    await run(['updates:prepare', store, ...pinned, ...repositoryFlags, '--output', join(directory, 'bad-image')], 1)
    const stopped = await run(['updates:store', store, ...pinned])
    assert.equal(stopped.releaseFloor, 9); assert.equal(stopped.attempt.phase, 'maintenance')
    const recovered = await run(['updates:recover', store, ...pinned])
    assert.equal(recovered.releaseFloor, 9); assert.equal(recovered.attempt.phase, 'recovered'); assert.equal(Object.hasOwn(recovered, 'candidate'), false); assert.equal(recovered.physicalDeploymentAllowed, false)
    await writeFile(fixture.imagePath, fixture.image)
    const fresh = await run(['updates:prepare', store, ...pinned, ...repositoryFlags, '--output', join(directory, 'fresh-candidate')])
    assert.equal(fresh.candidate.sha256, fixture.imageHash); assert.equal(fresh.store.releaseFloor, 9); assert.equal(fresh.physicalDeploymentAllowed, false)
    await run(['updates:prepare', store, ...flags, '--store-sha256', '0'.repeat(64), ...repositoryFlags, '--output', join(directory, 'wrong-pin')], 1)
    assert.deepEqual(await run(['updates:store', store, ...pinned]), fresh.store)
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'copied-standalone-preparation-v1', sourceSha256, results, physicalDeploymentAllowed: false }, null, 2)) }
  return { evidence: 'copied-standalone-preparation-v1', operations: results.length, sourceSha256, physicalDeploymentAllowed: false }
}
if (import.meta.main) {
  if (process.argv.length !== 4) throw new Error('Use qualify-preparation.ts NEW_DIRECTORY COMPILED_BINARY')
  console.log(JSON.stringify(await qualifyPortablePreparation(resolve(process.argv[2]!), resolve(process.argv[3]!))))
}
