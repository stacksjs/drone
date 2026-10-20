import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real HTTP/Auth/Gates and disposable file-backed SQLite. This does not authorize a vehicle.
async function runFixture(variant: string, nativeRoutes = false) {
  const directory = await mkdtemp(join(tmpdir(), 'drone-patrol-review-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/patrol-review/create-read.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'review.sqlite'), PATROL_REVIEW_CASE: variant, PATROL_NATIVE_ROUTES: String(nativeRoutes) }, stdout: 'pipe', stderr: 'pipe',
    })
    let timedOut = false
    const guard = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      // Only fixture-selected PASS and bounded scalar diagnostic lines are released, never credentials.
      for (const line of stdout.split('\n')) {
        // eslint-disable-next-line no-console
        if (line.startsWith('PASS ') || line.startsWith('{\"label\"')) console.log(line)
      }
      expect(timedOut).toBe(false)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native patrol create and owner read without execution')
      if (variant === 'corruption') expect(stdout).toContain('PASS native patrol corrupt stored dates, due tuples and raw JSON bounds refuse without read repair')
      if (variant === 'invalid-primitives') expect(stdout).toContain('PASS native patrol exact primitive boundaries reject trailing newline and nonselected frames')
      if (variant === 'quota') expect(stdout).toContain('PASS native single-process sixteen-schedule capacity and exact creation receipt at capacity')
      if (variant === 'rollback') expect(stdout).toContain('PASS actual audit INSERT failure rolls back patrol schedule and both occurrence rows')
      if (variant === 'access') expect(stdout).toContain('PASS native patrol current access, private projections, canonical intent and original-token create receipts')
    }
    finally { clearTimeout(guard) }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('native patrol owner creates immutable declared intent and reads its private bounded audit', () => runFixture('create-read'), 70000)
test('native patrol access and original-token receipts preserve private immutable owner intent', () => runFixture('access'), 70000)

test('native patrol sixteen-schedule quota preserves a creation receipt at capacity', () => runFixture('quota'), 70000)
test('native patrol audit persistence failure rolls back the complete new ledger', () => runFixture('rollback'), 70000)
test('native patrol exact primitive boundaries refuse malformed declared intent', () => runFixture('invalid-primitives'), 70000)
test('native patrol private reads refuse corrupt stored schema and canonical joins without repair', () => runFixture('corruption'), 70000)
test('native patrol create and read pass through the native route table', () => runFixture('create-read', true), 70000)

test('native patrol deny-only reviewer commits terminal denial and historical receipt', () => runFixture('denial'), 70000)

test('native patrol approval is consumed once and historical receipts survive later transitions', () => runFixture('consume'), 70000)

test('native patrol decision and consume require current grants original token and exact request namespace', () => runFixture('decision-access'), 70000)

test('native patrol transition audit failure rolls back review and consumption CAS', () => runFixture('transition-rollback'), 70000)

test('native patrol synthetic matching future history remains readable while new UTC transition refuses', () => runFixture('future-history'), 70000)
test('native patrol synthetic expired approved history is read only and replay never renews eligibility', () => runFixture('expired-history'), 70000)

test('native patrol genuine original token expiry bounds approval lifetime and current authentication', () => runFixture('token-deadline'), 70000)
test('native patrol full historical fold refuses corrupt transition facts on read and replay', () => runFixture('fold-corruption'), 70000)

test('native patrol fresh process reads two consumed tuples and every historical receipt from SQLite', () => runFixture('restart'), 70000)

test('native patrol synthetic consumed receipt remains historical after its approval expiry', () => runFixture('expired-consumed-history'), 70000)

test('native patrol observed SQLite writer busy returns503 without protected writes or retry', () => runFixture('busy'), 70000)

test('native patrol approval consumption and receipt lookup pass through native route dispatch', () => runFixture('consume', true), 70000)
