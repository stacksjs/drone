import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function runFixture(name: 'content-deadline' | 'content-deadline-http', nativeRoutes = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-content-deadline-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${name}.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', INCIDENT_NATIVE_ROUTES: String(nativeRoutes), DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    return stdout
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
test('incident content does not escape its deadline through actual native COMMIT release', async () => {
  expect(await runFixture('content-deadline')).toContain('PASS actual incident content refuses release after native COMMIT crosses retention')
}, 180000)
for (const nativeRoutes of [false, true]) test(`incident content does not escape through late HTTP middleware nativeRoutes=${nativeRoutes}`, async () => {
  expect(await runFixture('content-deadline-http', nativeRoutes)).toContain(`PASS actual9 content HTTP middleware deadline crossings nativeRoutes=${nativeRoutes}`)
}, 180000)
