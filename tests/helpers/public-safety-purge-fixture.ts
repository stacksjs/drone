import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Await one guarded native fixture. Elapsed time includes output drain; the
 * deadline marker and observed signal are separate facts, not a causal verdict.
 */
export async function runPurgeQualificationFixture(name: string, timeoutMs: number): Promise<{ code: number, stdout: string, stderr: string, lifecycle: Readonly<{ pid: number, timeoutMs: number, deadlineFired: boolean, elapsedMs: number, signal: string | number | null }> }> {
  if (!['purge-faults', 'purge-critical', 'purge-budget', 'purge-capacity', 'purge-sql', 'purge-relations', 'purge-seal', 'purge-bounds', 'purge-mixed', 'purge-namespace-identity'].includes(name)) throw new Error('Unknown qualification fixture')
  const root = await mkdtemp(join(tmpdir(), `drone-incident-access-${name}-`))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const started = performance.now()
    let deadlineFired = false
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${name}.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => {
      if (running.exitCode !== null) return
      deadlineFired = true
      running.kill('SIGKILL')
      console.error('PURGE_FIXTURE_DEADLINE', JSON.stringify({ fixture: name, pid: running.pid, timeoutMs, elapsedMs: performance.now() - started, requestedSignal: 'SIGKILL' }))
    }, timeoutMs)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      const lifecycle = Object.freeze({ pid: running.pid, timeoutMs, deadlineFired, elapsedMs: performance.now() - started, signal: running.signalCode ?? null })
      if (code !== 0) console.error('PURGE_FIXTURE_EXIT', JSON.stringify({ fixture: name, code, ...lifecycle }))
      return { code, stdout, stderr, lifecycle }
    }
    finally { clearTimeout(timer) }
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
