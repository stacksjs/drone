import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { repository, platform, target } from './repository'

async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Real copied standalone CLI, generated throwaway keys, no firmware deployment. */
export async function qualifyRuntimeTrust(directory: string, source: string) {
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), sourceSha256 = await hashFile(source)
  await copyFile(source, binary, constants.COPYFILE_EXCL)
  await chmod(binary, 0o700)
  if (await hashFile(binary) !== sourceSha256 || await hashFile(source) !== sourceSha256) throw new Error('Changed portable trust executable')
  const fixture = await repository(join(directory, 'repo')), output = join(directory, 'trust')
  const flags = ['--target', target, '--platform', platform, '--root-sha256', fixture.rootSha256, '--minimum-release-sequence', '7']
  const results: { command: string, exit: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected: number) {
    const child = Bun.spawn([binary, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      results.push({ command: args[0]!, exit, stdout, stderr })
      if (exit !== expected) throw new Error(`Unexpected portable trust exit: ${exit}`)
      return stdout
    }
    finally { clearTimeout(timer) }
  }
  try {
    const enrolled = JSON.parse(await run(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', output, ...flags], 0))
    if (enrolled.policy.trustedRootSha256 !== fixture.rootSha256 || enrolled.policy.minimumReleaseSequence !== 7 || enrolled.metadataState !== 'initial-root-only' || enrolled.metadataRefreshPerformed !== false || enrolled.firmwareSelectionPerformed !== false || enrolled.physicalDeploymentAllowed !== false) throw new Error('Invalid portable trust enrollment')
    const inspected = JSON.parse(await run(['updates:trust', output, '--enrollment-sha256', enrolled.enrollmentSha256], 0))
    if (JSON.stringify(inspected) !== JSON.stringify(enrolled)) throw new Error('Portable enrollment mismatch')
    const marker = await readFile(join(output, 'enrollment.json'))
    const rejected = await run(['updates:trust', output, '--enrollment-sha256', '0'.repeat(64)], 1)
    if (rejected !== '' || !(await readFile(join(output, 'root.json'))).equals(await readFile(fixture.rootPath))) throw new Error('Rejected trust readback changed the anchor')
    if (await run(['updates:enroll', '--trusted-root', fixture.rootPath, '--output', output, ...flags], 1) !== '' || !(await readFile(join(output, 'enrollment.json'))).equals(marker)) throw new Error('Existing enrollment was overwritten')
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'generated-initial-trust-only', sourceSha256, copiedExecutableBytes: (await stat(binary)).size, metadataRefreshPerformed: false, firmwareSelectionPerformed: false, physicalFirmwareInstalled: false, results }, null, 2)) }
  return { evidence: 'generated-initial-trust-only', operations: results.length, sourceSha256, metadataRefreshPerformed: false, firmwareSelectionPerformed: false, physicalFirmwareInstalled: false }
}
if (import.meta.main) {
  if (process.argv.length !== 4) throw new Error('Use qualify-trust.ts NEW_DIRECTORY COMPILED_BINARY')
  console.log(JSON.stringify(await qualifyRuntimeTrust(resolve(process.argv[2]!), resolve(process.argv[3]!))))
}
