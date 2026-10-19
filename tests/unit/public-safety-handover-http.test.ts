import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

// Actual native loopback routes catch Auth, Gates, CSRF, bounded bodies and response release.
// Disposable SQLite does not qualify production identity providers, operators or physical outputs.
async function qualify(fixture: string, nativeRoutes: boolean, crossing?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${fixture}.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes), ...(crossing ? { HANDOVER_DEADLINE_CASE: crossing } : {}) }, stdout: 'pipe', stderr: 'pipe',
    })
    let timedOut = false
    const started = Date.now()
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, crossing ? 85000 : 55000)
    let result: [number, string, string]
    try { result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
    finally { clearTimeout(timer) }
    const [code, stdout, stderr] = result
    expect(code, `${fixture}/${crossing ?? 'wire'} timedOut=${timedOut}, elapsedMs=${Date.now() - started}, hostLoad=${loadavg().join(',')}\n${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain(crossing ? `PASS actual handover ${crossing} offer expiry nativeRoutes=${nativeRoutes}` : `PASS native incident handover HTTP nativeRoutes=${nativeRoutes}`)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}
for (const nativeRoutes of [false, true]) {
  test(`native incident handover HTTP with nativeRoutes=${nativeRoutes}`, () => qualify('handover-http', nativeRoutes), 60000)
  test(`native handover offer expiry HTTP with nativeRoutes=${nativeRoutes}`, async () => {
    // Each child owns a different native database. Await every child even when
    // another case fails, so no timed qualification outlives its parent test.
    const results = await Promise.allSettled(['offer-commit', 'decision-commit', 'offer-middleware', 'decision-middleware', 'pending-middleware'].map(crossing => qualify('handover-deadline-http', nativeRoutes, crossing)))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }, 90000)
}
