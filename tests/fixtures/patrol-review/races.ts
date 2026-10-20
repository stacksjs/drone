import assert from 'node:assert/strict'
import { join } from 'node:path'
import { asRows } from '@stacksjs/database/runtime'
import { openNativeFixture, intent, uuid } from './http-fixture'

async function main() {
  const context = await openNativeFixture()
  try {
    const { token, userId } = await context.owner(), variant = process.env.PATROL_QUALIFICATION!
    if (variant === 'race-quota') {
      for (let n = 0; n < 15; n++) assert.equal((await context.call('POST', '/api/patrol/reviews', token.plainTextToken, { ...intent, scheduleKey: `seed-${n}`, requestId: uuid(n + 1) })).status, 201)
    }
    const path = `/api/patrol/reviews/${intent.scheduleKey}`
    let baseline: any
    if (variant === 'race-review' || variant === 'race-consume') {
      assert.equal((await context.call('POST', '/api/patrol/reviews', token.plainTextToken, intent)).status, 201)
      baseline = (await context.call('GET', path, token.plainTextToken)).data
      if (variant === 'race-consume') {
        assert.equal((await context.call('POST', `${path}/occurrences/1767225600000/decision`, token.plainTextToken, { expectedVersion: 1, requestId: uuid(2), scopeDigest: baseline.occurrences[0].scopeDigest, decision: 'approve' })).status, 200)
        baseline = (await context.call('GET', path, token.plainTextToken)).data
      }
    }
    const payloads = [0, 1].map(index => {
      if (variant === 'race-quota' || variant === 'race-key') return { path: '/api/patrol/reviews', body: { ...intent, scheduleKey: variant === 'race-key' ? 'same-racing-key' : `race-key-${index}`, requestId: uuid(index + 20) }, ability: 'patrol:create', gateCount: 2, credential: token.plainTextToken, ownerId: userId }
      if (variant === 'race-review') return { path: `${path}/occurrences/1767225600000/decision`, body: { expectedVersion: 1, requestId: uuid(index + 20), scopeDigest: baseline.occurrences[0].scopeDigest, decision: index === 0 ? 'approve' : 'deny' }, ability: index === 0 ? 'patrol:approve' : 'patrol:review', gateCount: index === 0 ? 1 : 3, credential: token.plainTextToken, ownerId: userId }
      assert.equal(variant, 'race-consume')
      return { path: `${path}/occurrences/1767225600000/consume`, body: { expectedVersion: 2, requestId: uuid(index + 20), scopeDigest: baseline.occurrences[0].scopeDigest }, ability: 'patrol:consume', gateCount: 3, credential: token.plainTextToken, ownerId: userId }
    })
    const launched = payloads.map(input => {
      let ready!: () => void, rejectReady!: (error: Error) => void
      const preflight = new Promise<void>((resolve, reject) => {
        ready = resolve
        rejectReady = reject
      })
      let actualPid = 0, preflightCount = 0
      const child = Bun.spawn([process.execPath, `--config=${join(context.root, 'bunfig.toml')}`, '--no-env-file', join(import.meta.dir, 'race-child.ts')], {
        cwd: context.root, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
        ipc(message, subprocess) {
          if (message.kind === 'ready-input') subprocess.send({ kind: 'init', input })
          if (message.kind === 'preflight') {
            actualPid = message.pid
            preflightCount++
            ready()
          }
        },
      })
      const redact = (text: string) => text.replaceAll(input.credential, '[redacted-fixture-credential]')
      const stdout = new Response(child.stdout).text().then(redact), stderr = new Response(child.stderr).text().then(redact)
      child.exited.then(async code => {
        const [out, err] = await Promise.all([stdout, stderr])
        rejectReady(new Error(`Native race child exited${code} before synchronized preflight; stdout:${out.slice(-16000)} stderr:${err.slice(-16000)}`))
      })
      return { child, stdout, stderr, preflight, observation: () => ({ actualPid, preflightCount }) }
    })
    let timedOut = false
    const guard = setTimeout(() => {
      timedOut = true
      for (const item of launched) item.child.kill()
    }, 25000)
    try {
      await Promise.all(launched.map(item => item.preflight))
      const pids = launched.map(item => item.observation().actualPid)
      assert.equal(new Set(pids).size, 2)
      assert(pids.every(pid => pid !== process.pid && pid > 0))
      for (const item of launched) assert.equal(item.observation().preflightCount, 1)
      // Test-only barrier releases two independent native processes; it is not a writer mutex.
      for (const item of launched) item.child.send({ kind: 'go' })
      const outcomes = []
      for (const item of launched) {
        const [code, stdout, stderr] = await Promise.all([item.child.exited, item.stdout, item.stderr])
        assert.equal(code, 0, stderr)
        const line = stdout.split('\n').find(line => line.startsWith('RACE_RESULT '))
        assert(line, stdout)
        outcomes.push(JSON.parse(line.slice('RACE_RESULT '.length)))
      }
      assert.equal(timedOut, false)
      if (variant === 'race-consume' || variant === 'race-review') {
        const actual = await context.call('GET', path, token.plainTextToken)
        // Bounded original public receipts/errors and current scalar/state facts before any outcome oracle.
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ label: 'actual-preassert-native-race-outcomes', variant, outcomes, getStatus: actual.status, scheduleVersion: actual.data.scheduleVersion ?? null, occurrenceStates: actual.data.occurrences?.map((o: { state: string }) => o.state) ?? null, auditActions: actual.data.audit?.map((a: { action: string }) => a.action) ?? null }))
      }
      const winnerStatus = variant === 'race-quota' || variant === 'race-key' ? 201 : 200
      assert.equal(outcomes.filter(item => item.status === winnerStatus).length, 1)
      assert.equal(outcomes.filter(item => item.status === 409 || item.status === 503).length, 1)
      if (variant === 'race-quota' || variant === 'race-key') {
        const parents = asRows<{ id: number, schedule_key: string }>(await context.database.db.primary.selectFrom('patrol_review_schedules').select(['id', 'schedule_key']).where('owner_user_id', '=', userId).execute())
        assert.equal(parents.length, variant === 'race-quota' ? 16 : 1)
        for (const parent of parents) {
          const read = await context.call('GET', `/api/patrol/reviews/${parent.schedule_key}`, token.plainTextToken)
          assert.equal(read.status, 200)
          assert.equal(read.data.occurrences.length, 2)
          assert.equal(read.data.audit.length, 1)
        }
        assert.equal(asRows(await context.database.db.primary.selectFrom('patrol_review_occurrences').select('id').execute()).length, parents.length * 2)
        assert.equal(asRows(await context.database.db.primary.selectFrom('patrol_review_audits').select('id').execute()).length, parents.length)
      }
      else {
        const read = await context.call('GET', path, token.plainTextToken)
        assert.equal(read.status, 200)
        assert.equal(read.data.scheduleVersion, variant === 'race-consume' ? 3 : 2)
        assert.equal(read.data.audit.length, variant === 'race-consume' ? 3 : 2)
        assert.equal(read.data.occurrences[1].state, 'awaiting-review')
        if (variant === 'race-consume') {
          assert.equal(read.data.occurrences[0].state, 'consumed')
          assert.equal(outcomes.filter(item => item.data.consumedNow === true).length, 1)
          assert.equal(read.data.audit.filter((a: { action: string }) => a.action === 'consumed').length, 1)
        }
        else assert(['approved', 'denied'].includes(read.data.occurrences[0].state))
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ label: 'actual-two-process-native-patrol-race', variant, pids, finalCount: variant === 'race-quota' ? 16 : 1, outcomes: outcomes.map(item => ({ pid: item.pid, status: item.status, consumedNow: item.data.consumedNow ?? false, gates: item.gates })) }))
      // eslint-disable-next-line no-console
      console.log('PASS two independent native processes synchronize after actual allowed Gates and commit exactly one bounded transition')
    }
    finally {
      clearTimeout(guard)
      for (const item of launched) if (item.child.exitCode === null) item.child.kill()
      await Promise.all(launched.map(item => item.child.exited))
    }
  }
  finally { await context.close() }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
