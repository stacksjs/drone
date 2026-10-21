import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { repository, platform, target } from './repository'

/** Qualification uses generated test payloads/keys and never executes an image. */
export async function qualifyRuntimeUpdates(directory: string, binary: string) {
  await mkdir(directory, { mode: 0o700 })
  const repo = join(directory, 'repo'), candidate = join(directory, 'candidate'), fixture = await repository(repo)
  const flags = ['--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7']
  const results: { command: string, exit: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected: number) {
    const child = Bun.spawn([binary, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      results.push({ command: args[0]!, exit, stdout, stderr })
      if (exit !== expected) throw new Error(`Unexpected portable update exit: ${exit}`)
      return stdout
    }
    finally { clearTimeout(timer) }
  }
  try {
    const staged = JSON.parse(await run(['updates:stage', repo, '--trusted-root', fixture.rootPath, '--output', candidate, ...flags], 0))
    if (staged.sha256 !== fixture.imageHash || staged.physicalDeploymentAllowed !== false || staged.trustStatePersisted !== false) throw new Error('Invalid portable stage result')
    const inspected = JSON.parse(await run(['updates:inspect', candidate, ...flags], 0))
    if (JSON.stringify(inspected) !== JSON.stringify(staged)) throw new Error('Portable re-verification mismatch')
    const rejected = await run(['updates:inspect', candidate, ...flags.slice(0, -1), '8'], 1)
    if (rejected !== '' || !(await readFile(join(candidate, 'image.bin'))).equals(fixture.image)) throw new Error('Rejected verification changed the candidate')
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'generated-signed-test-payload-only', physicalFirmwareInstalled: false, results }, null, 2)) }
  return { evidence: 'generated-signed-test-payload-only', operations: results.length, physicalFirmwareInstalled: false }
}
if (import.meta.main) {
  if (process.argv.length !== 4) throw new Error('Use qualify.ts NEW_DIRECTORY COMPILED_BINARY')
  console.log(JSON.stringify(await qualifyRuntimeUpdates(resolve(process.argv[2]!), resolve(process.argv[3]!))))
}
