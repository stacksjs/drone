import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Real metadata qualification, reusable by a controlled Linux namespace entrypoint. */
export async function qualifyPurgeMetadata(options: { requirePositive?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-metadata-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-metadata.ts`, ...(options.requirePositive ? ['--require-positive'] : [])], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    return { code, stdout, stderr, positiveQualified: stdout.includes('PASS actual awaited native metadata retirement removed receipt scope grants and tombstone') }
  }
  finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}
