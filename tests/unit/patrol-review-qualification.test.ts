import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function run(variant: string) {
  const directory = await mkdtemp(join(tmpdir(), 'drone-patrol-review-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', join(import.meta.dir, variant === 'service-snapshot-busy' ? '../fixtures/patrol-review/service-snapshot-busy.ts' : variant === 'service-busy' ? '../fixtures/patrol-review/service-busy.ts' : variant === 'credential-kinds' ? '../fixtures/patrol-review/credential-kinds.ts' : variant === 'wire' ? '../fixtures/patrol-review/wire.ts' : variant === 'generic' ? '../fixtures/patrol-review/generic-app-boundary.ts' : variant.startsWith('after-') ? '../fixtures/patrol-review/after-gate.ts' : variant.startsWith('race-') ? '../fixtures/patrol-review/races.ts' : '../fixtures/patrol-review/qualification.ts')], { cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'review.sqlite'), PATROL_QUALIFICATION: variant }, stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const guard = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      for (const line of stdout.split('\n')) {
        // eslint-disable-next-line no-console
        if (line.startsWith('PASS ') || line.startsWith('{"label"')) console.log(line)
      }
      expect(timedOut).toBe(false)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS ')
    }
    finally { clearTimeout(guard) }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}
test('native patrol maximal valid identifiers and complete five-audit projection fit fixed UTF8 bounds', () => run('maximal'), 70000)

test('native registered generic routes are blocked by application privacy boundary with real public and patrol controls', () => run('generic'), 70000)

test('native patrol committed token revocation after allowed Gate refuses in final transaction', () => run('after-token'), 70000)

test('native patrol committed consume permission removal after allowed Gate refuses final transaction', () => run('after-permission'), 70000)

test('native patrol actual committed password hash and credential stamp change refuses final transaction', () => run('after-password'), 70000)

test('native two-process patrol quota from fifteen commits exactly one complete sixteenth schedule', () => run('race-quota'), 70000)

test('native two-process same-key patrol creates commit exactly one complete immutable ledger', () => run('race-key'), 70000)

test('native two-process opposing patrol reviews commit one decision and one audit increment', () => run('race-review'), 70000)

test('native two-process competing patrol consumes acknowledge exactly one durable transition', () => run('race-consume'), 70000)

test('native patrol wire byte media and UTF8 validation plus occurrence insertion rollback preserve private state', () => run('wire'), 70000)

test('native valid session and delegated OAuth credentials do not grant personal-token patrol access', () => run('credential-kinds'), 70000)

test('native patrol actual CAS writer conflict returns observed busy503 and leaves ledger unchanged', () => run('service-busy'), 70000)

test('native patrol WAL snapshot conflict returns observed busy503 without a transaction retry', () => run('service-snapshot-busy'), 70000)
