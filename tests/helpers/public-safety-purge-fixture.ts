import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Await one guarded native fixture and own its terminal process boundary. */
export async function runPurgeQualificationFixture(name: string, timeoutMs: number): Promise<{ code: number, stdout: string, stderr: string }> {
  if (!['purge-faults', 'purge-critical'].includes(name)) throw new Error('Unknown qualification fixture')
  const root = await mkdtemp(join(tmpdir(), `drone-incident-access-${name}-`))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${name}.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, timeoutMs)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      return { code, stdout, stderr }
    }
    finally { clearTimeout(timer) }
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
