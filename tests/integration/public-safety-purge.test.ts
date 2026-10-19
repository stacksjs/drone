import { expect, test } from 'bun:test'
import { readFileSync, readlinkSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualifyPurgeProcessRecovery } from '../helpers/public-safety-purge-process'
// Run explicitly in the real privileged PID/proc/mount namespace. An ordinary-suite skip is unqualified, never positive removal evidence.
test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies real process references, mounts and positive namespace removal', async () => {
  requireQualifiedNamespace()
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-namespace-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge.ts`, '--require-positive'], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual namespace process reference and bind mount')
    expect(stdout).toContain('PASS actual native Job purge removes accepted files')
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 180000)

function requireQualifiedNamespace(): void {
  expect(process.platform).toBe('linux')
  expect(process.pid).toBe(1)
  expect(readlinkSync('/proc/self/ns/pid')).toBe(readlinkSync('/proc/1/ns/pid'))
  expect(/^NSpid:\s+1\s*$/m.test(readFileSync('/proc/self/status', 'utf8'))).toBe(true)
}

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge recovers genuine SIGKILL after namespace unlink', async () => {
  requireQualifiedNamespace()
  await qualifyPurgeProcessRecovery()
}, 180000)
