import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { refreshRuntimeTrustStore } from '../../../resources/functions/drone/updates/store'
import { platform, repository, target } from './repository'

async function hash(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex') }

/** Actual copied CLI plus a source-side interrupted input to exercise the same persisted recovery format. */
export async function qualifyPortableStore(directory: string, source: string) {
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), sourceSha256 = await hash(source)
  await copyFile(source, binary, constants.COPYFILE_EXCL); await chmod(binary, 0o700)
  assert.equal(await hash(binary), sourceSha256); assert.equal(await hash(source), sourceSha256)
  const repo = join(directory, 'repo'), fixture = await repository(repo, { custom: { releaseSequence: 9 } })
  const enrollment = join(directory, 'enrollment'), store = join(directory, 'store')
  const results: { command: string, exit: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected = 0) {
    const child = Bun.spawn([binary, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      results.push({ command: args[0]!, exit, stdout, stderr })
      assert.equal(exit, expected)
      if (expected) { assert.equal(stdout, ''); assert.equal(stderr, 'Runtime update store unavailable: invalid trust, clock, state or storage failure\n') }
      return stdout ? JSON.parse(stdout) : undefined
    }
    finally { clearTimeout(timer) }
  }
  try {
    const enrolled = await run(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', enrollment, '--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7'])
    const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256]
    const created = await run(['updates:store-init', ...flags, '--output', store])
    assert.equal(created.generation, 0); assert.equal(created.releaseFloor, 7)
    const pinned = [...flags, '--store-sha256', created.storeSha256]
    await run(['updates:refresh', store, ...pinned, '--repository', repo], 1)
    const marker = new Error('Synthetic interruption after timestamp input commit')
    const rejected = await refreshRuntimeTrustStore({ directory: store, storeSha256: created.storeSha256, enrollmentDirectory: enrollment, enrollmentSha256: enrolled.enrollmentSha256, repository: repo, clock: { source: 'synthetic-host-current-clock', read: () => new Date() }, onProgress(event) {
      if (event.phase === 'input-committed' && event.ordinal === 1) throw marker
    } }).then(() => undefined, error => error)
    assert.ok(rejected instanceof Error)
    assert.equal(rejected.cause, marker)
    const recovered = await run(['updates:recover', store, ...pinned])
    assert.equal(recovered.generation, 1); assert.equal(recovered.releaseFloor, 7); assert.equal(recovered.attempt.phase, 'recovered')
    const refreshed = await run(['updates:refresh', store, ...pinned, '--repository', repo, '--trusted-system-clock-source', 'operator-managed-test-clock'])
    assert.equal(refreshed.generation, 3); assert.equal(refreshed.releaseFloor, 9); assert.equal(refreshed.attempt.phase, 'verified'); assert.equal(refreshed.physicalDeploymentAllowed, false)
    assert.deepEqual(await run(['updates:store', store, ...pinned]), refreshed)
    await run(['updates:store', store, ...flags, '--store-sha256', '0'.repeat(64)], 1)
    await run(['updates:recover', store, ...pinned], 1)
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'copied-standalone-store-v1', sourceSha256, sourceSideInterruption: 'callback after committed input, not a process kill', results, physicalDeploymentAllowed: false }, null, 2)) }
  return { evidence: 'copied-standalone-store-v1', operations: results.length, sourceSha256, physicalDeploymentAllowed: false }
}
if (import.meta.main) {
  if (process.argv.length !== 4) throw new Error('Use qualify-store.ts NEW_DIRECTORY COMPILED_BINARY')
  console.log(JSON.stringify(await qualifyPortableStore(resolve(process.argv[2]!), resolve(process.argv[3]!))))
}
