import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

async function hash(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex') }
async function qualify(directory: string) {
  await mkdir(directory, { mode: 0o700 })
  const built = join(directory, 'sdk-built'), outside = join(directory, 'portable')
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'sdk-outcomes-worker.ts')], target: 'bun', minify: true, compile: { outfile: built, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false } })
  if (!result.success) throw new AggregateError(result.logs, 'SDK qualifier compilation failed')
  const sourceSha256 = await hash(built)
  await mkdir(outside, { mode: 0o700 })
  const binary = join(outside, 'sdk')
  await copyFile(built, binary, constants.COPYFILE_EXCL)
  await chmod(binary, 0o700)
  if (await hash(binary) !== sourceSha256 || await hash(built) !== sourceSha256) throw new Error('SDK qualifier executable changed')
  const child = Bun.spawn([binary, join(outside, 'data')], { cwd: outside, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    await writeFile(join(directory, 'qualification.json'), JSON.stringify({ sourceSha256, exit, stdout, stderr }, null, 2))
    if (exit !== 0) throw new Error('Copied standalone SDK outcome qualification failed')
    const observed = JSON.parse(stdout)
    if (observed.evidence !== 'synthetic-sdk-operational-errors-v1' || observed.physicalDeploymentAllowed !== false || observed.outcomes.length !== 4) throw new Error('Invalid SDK outcome qualification')
    return { ...observed, sourceSha256, copiedStandaloneExecutable: true }
  }
  finally { clearTimeout(timer) }
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Use qualify-sdk.ts NEW_DIRECTORY')
  console.log(JSON.stringify(await qualify(resolve(process.argv[2]!))))
}
