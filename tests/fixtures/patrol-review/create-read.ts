import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupPatrolDatabase } from './setup'

async function main() {
  const { root, database, User } = await setupPatrolDatabase()
  const source = resolve(import.meta.dir, '../../..')
  await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
  const { initializeAuthorization } = await import('@stacksjs/auth/policy')
  await initializeAuthorization()
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const { createToken } = await import('@stacksjs/auth/tokens')
  const { route } = await import('@stacksjs/router')
  await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
  const observedBodies = new Map<string, boolean>()
  route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
    try { return await next() }
    finally {
      const marker = request.headers.get('x-fixture-unread')
      if (marker) observedBodies.set(marker, request.bodyUsed)
    }
  })
  const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: process.env.PATROL_NATIVE_ROUTES === 'true' })
  try {
    const user = await User.create({ name: 'Patrol Owner', email: 'patrol-owner@example.invalid', password: 'temporary-fixture-password' })
    for (const permission of ['patrol:access', 'patrol:create', 'patrol:read', 'patrol:review', 'patrol:consume']) {
      await Rbac.createPermission(permission, 'web')
      await Rbac.givePermission(user.id, permission, 'web')
    }
    const token = await createToken(user.id, 'patrol fixture', ['patrol:create', 'patrol:read', 'patrol:review', 'patrol:consume'], { withRefreshToken: false })
    const body = {
      requestId: '11111111-1111-4111-8111-111111111111', scheduleKey: 'owner-first',
      input: { profile: 'nominal', unsignedLocalReview: true, enableCharge: false, decisions: [
        { kind: 'flight', id: 'first', atMs: 2000, dueUtcMs: 1767225600000, decision: 'approve' },
        { kind: 'flight', id: 'second', atMs: 60000, dueUtcMs: 1767225660000, decision: 'approve' },
      ] },
      binding: { vehicleId: 'navigation-vehicle', padId: 'pad', planId: 'local-survey-demo', profile: 'nominal-contact-partial-charge-v1', sessionId: '123', bootId: '55', reference: '55:0,0,0,0,0', origin: '{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":100}' },
    }
    assert.equal(Buffer.byteLength(body.binding.origin), 57)
    const headers = { authorization: `Bearer ${token.plainTextToken}`, accept: 'application/json', 'content-type': 'application/json' }
    const created = await fetch(`http://127.0.0.1:${server.port}/api/patrol/reviews`, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(created.status, 201)
    const receipt = await created.json()
    assert.equal(receipt.scheduleKey, body.scheduleKey)
    assert.equal(receipt.currentVersion, 1)
    assert.equal(receipt.replayed, false)
    assert.equal(receipt.launchAuthorized, false)
    assert.equal(receipt.handoff, null)
    assert.equal(Object.hasOwn(receipt, 'input'), false)
    const read = await fetch(`http://127.0.0.1:${server.port}/api/patrol/reviews/${body.scheduleKey}`, { headers })
    assert.equal(read.status, 200)
    const schedule = await read.json()
    assert.equal(schedule.ownerUserId, user.id)
    assert.equal(schedule.scheduleVersion, 1)
    assert.deepEqual(schedule.input, body.input)
    assert.deepEqual(schedule.binding, body.binding)
    assert.deepEqual(schedule.occurrences.map((o: { state: string }) => o.state), ['awaiting-review', 'awaiting-review'])
    assert.deepEqual(schedule.audit.map((a: { action: string }) => a.action), ['created'])
    assert.equal(schedule.actorIdentityAuthenticated, true)
    assert.equal(schedule.bindingIdentityAuthenticated, false)
    assert.equal(schedule.executionState, 'not-requested')
    const request = async (method: string, path: string, credential: string | null, value?: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { accept: 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) })
      const text = await response.text()
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const vary = response.headers.get('vary')!.split(',').map(v => v.trim().toLowerCase())
      assert(vary.includes('authorization') && vary.includes('cookie'))
      assert.equal(text.endsWith('\n'), true)
      assert(Buffer.byteLength(text) <= (method === 'POST' ? 2048 : 16384))
      const data = JSON.parse(text)
      if (response.status >= 400) assert.deepEqual(Object.keys(data), ['error'])
      assert(!text.includes(token.plainTextToken))
      return { status: response.status, data }
    }
    const path = `/api/patrol/reviews/${body.scheduleKey}`
    if (process.env.PATROL_REVIEW_CASE === 'busy') {
      const { Database } = await import('bun:sqlite')
      const writer = new Database(process.env.DB_DATABASE_PATH!)
      writer.exec('BEGIN IMMEDIATE')
      try {
        let observed: unknown, callbackAttempts = 0
        try {
          await database.db.transaction(async tx => {
            callbackAttempts++
            await tx.updateTable('patrol_review_schedules').set({ version: 2 }).where('schedule_key', '=', body.scheduleKey).executeTakeFirst()
          }, { retries: 0 })
        }
        catch (error) { observed = error }
        assert(observed && typeof observed === 'object')
        assert.equal(callbackAttempts, 1)
        // Native error identity only, no SQL, credentials, arbitrary messages or dynamic exception details.
        const fields = (value: object) => Object.fromEntries(['name', 'code', 'errno'].map(k => [k, Reflect.get(value, k)]))
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ label: 'actual-native-sqlite-busy', callbackAttempts, ...fields(observed), cause: 'cause' in observed && observed.cause && typeof observed.cause === 'object' ? fields(observed.cause) : null }))
        const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
        assert.equal((await request('POST', `${path}/occurrences/1767225600000/decision`, token.plainTextToken, approval, { 'x-fixture-unread': 'busy-auth' })).status, 503)
        assert.equal(observedBodies.get('busy-auth'), false)
      }
      finally {
        writer.exec('ROLLBACK')
        writer.close()
      }
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      // Same-process independent native SQLite connection, NOT final multiprocess race/quota proof.
      // eslint-disable-next-line no-console
      console.log('PASS observed native SQLite writer busy maps to generic503 without protected change; native probe callback once with retries0')
    }
    if (process.env.PATROL_REVIEW_CASE === 'restart') {
      const requests: { path: string, body: unknown, receipt: unknown }[] = [{ path: '/api/patrol/reviews', body, receipt: receipt.receipt }]
      for (const [index, due] of [1767225600000, 1767225660000].entries()) {
        const n = index * 2 + 2
        const approval = { expectedVersion: index * 2 + 1, requestId: `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`, scopeDigest: schedule.occurrences[index].scopeDigest, decision: 'approve' }
        const decisionPath = `${path}/occurrences/${due}/decision`, consumePath = `${path}/occurrences/${due}/consume`
        const approved = await request('POST', decisionPath, token.plainTextToken, approval)
        assert.equal(approved.status, 200)
        const m = n + 1
        const consume = { expectedVersion: index * 2 + 2, requestId: `${String(m).repeat(8)}-${String(m).repeat(4)}-4${String(m).repeat(3)}-8${String(m).repeat(3)}-${String(m).repeat(12)}`, scopeDigest: approval.scopeDigest }
        const consumed = await request('POST', consumePath, token.plainTextToken, consume)
        assert.equal(consumed.status, 200)
        assert.equal(consumed.data.consumedNow, true)
        requests.push({ path: decisionPath, body: approval, receipt: approved.data.receipt }, { path: consumePath, body: consume, receipt: consumed.data.receipt })
      }
      const complete = (await request('GET', path, token.plainTextToken)).data
      assert.equal(complete.scheduleVersion, 5)
      assert.equal(complete.audit.length, 5)
      assert.deepEqual(complete.occurrences.map((o: { state: string }) => o.state), ['consumed', 'consumed'])
      const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', join(import.meta.dir, 'restart-read.ts')], { cwd: root, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      child.stdin.write(JSON.stringify({ credential: token.plainTextToken, schedule: complete, requests }))
      child.stdin.end()
      let timedOut = false
      const guard = setTimeout(() => {
        timedOut = true
        child.kill()
      }, 15000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(timedOut, false)
        assert.equal(code, 0, stderr)
        assert(stdout.includes('PASS fresh native process reads durable five-audit ledger'))
      }
      finally { clearTimeout(guard) }
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, complete)
      // eslint-disable-next-line no-console
      console.log('PASS fresh native process reconstructs both consumed tuples and historical receipts from retained SQLite')
    }
    if (process.env.PATROL_REVIEW_CASE === 'token-deadline') {
      const deadline = new Date(Date.now() + 5000)
      const reviewer = await createToken(user.id, 'finite reviewer', ['patrol:review', 'patrol:consume'], { expiresAt: deadline, withRefreshToken: false })
      const a = `${path}/occurrences/1767225600000`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      const reviewed = await request('POST', `${a}/decision`, reviewer.plainTextToken, approval)
      assert.equal(reviewed.status, 200)
      for (const field of ['input', 'binding', 'ownerUserId', 'audit', 'requestDigest', 'tokenId']) assert.equal(Object.hasOwn(reviewed.data, field), false)
      const current = (await request('GET', path, token.plainTextToken)).data
      const actualExpiry = Date.parse(current.occurrences[0].expiresAt)
      assert(actualExpiry <= deadline.getTime())
      assert(actualExpiry > Date.parse(current.occurrences[0].reviewedAt))
      assert(actualExpiry - Date.parse(current.occurrences[0].reviewedAt) < 120000)
      await Bun.sleep(Math.max(0, deadline.getTime() - Date.now()) + 50)
      assert.equal((await request('POST', `${a}/decision`, reviewer.plainTextToken, approval)).status, 401)
      assert.equal((await request('POST', `${a}/consume`, reviewer.plainTextToken, { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest })).status, 401)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, current)
      // eslint-disable-next-line no-console
      console.log('PASS actual native short-lived original token caps approval expiry and blocks expired receipt or consume without mutation')
    }
    if (process.env.PATROL_REVIEW_CASE === 'fold-corruption') {
      const a = `${path}/occurrences/1767225600000`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      assert.equal((await request('POST', `${a}/decision`, token.plainTextToken, approval)).status, 200)
      const consume = { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest }
      assert.equal((await request('POST', `${a}/consume`, token.plainTextToken, consume)).status, 200)
      const baseline = (await request('GET', path, token.plainTextToken)).data
      const { asRow } = await import('@stacksjs/database/runtime')
      const parent = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_schedules').selectAll().where('owner_user_id', '=', user.id).where('schedule_key', '=', body.scheduleKey).executeTakeFirst())!
      const occurrence = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_occurrences').selectAll().where('schedule_id', '=', parent.id).where('due_utc_ms', '=', 1767225600000).executeTakeFirst())!
      const audit = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_audits').selectAll().where('schedule_id', '=', parent.id).where('sequence', '=', 2).executeTakeFirst())!
      for (const [table, row, field, changed] of [
        ['patrol_review_schedules', parent, 'version', 2],
        ['patrol_review_occurrences', occurrence, 'state', 'approved'],
        ['patrol_review_occurrences', occurrence, 'review_request_id', consume.requestId],
        ['patrol_review_occurrences', occurrence, 'reviewed_at_iso', '2020-01-01T00:00:00.000Z'],
        ['patrol_review_occurrences', occurrence, 'expires_at_iso', new Date(Date.parse(occurrence.reviewed_at_iso as string) + 120001).toISOString()],
        ['patrol_review_occurrences', occurrence, 'consume_request_id', approval.requestId],
        ['patrol_review_audits', audit, 'request_digest', '0'.repeat(64)],
        ['patrol_review_audits', audit, 'at_iso', '2020-01-01T00:00:00.000Z'],
        ['patrol_review_audits', audit, 'details_json', JSON.stringify({ ...JSON.parse(audit.details_json as string), previousVersion: 2 })],
        ['patrol_review_audits', audit, 'details_json', ` ${audit.details_json}`],
      ] as const) {
        await database.db.primary.updateTable(table).set({ [field]: changed }).where('id', '=', row.id).execute()
        assert.equal((await request('GET', path, token.plainTextToken)).status, 500)
        assert.equal((await request('POST', `${a}/decision`, token.plainTextToken, approval)).status, 500)
        const unchanged = asRow<Record<string, unknown>>(await database.db.primary.selectFrom(table).selectAll().where('id', '=', row.id).executeTakeFirst())!
        assert.equal(unchanged[field], changed)
        await database.db.primary.updateTable(table).set({ [field]: row[field] }).where('id', '=', row.id).execute()
        assert.deepEqual((await request('GET', path, token.plainTextToken)).data, baseline)
      }
      // eslint-disable-next-line no-console
      console.log('PASS complete historical fold rejects corrupt state digest dates versions and canonical audit joins on GET and exact replay')
    }
    if (process.env.PATROL_REVIEW_CASE === 'future-history') {
      const future = '2035-01-01T00:00:00.000Z'
      await database.db.primary.updateTable('patrol_review_schedules').set({ created_at_iso: future }).where('owner_user_id', '=', user.id).where('schedule_key', '=', body.scheduleKey).execute()
      await database.db.primary.updateTable('patrol_review_audits').set({ at_iso: future }).where('request_id', '=', body.requestId).execute()
      const historical = await request('GET', path, token.plainTextToken)
      assert.equal(historical.status, 200)
      assert.equal(historical.data.createdAt, future)
      const replay = await request('POST', '/api/patrol/reviews', token.plainTextToken, body)
      assert.equal(replay.status, 200)
      assert.equal(replay.data.receipt.at, future)
      assert.equal(replay.data.consumedNow, false)
      assert.equal(Object.hasOwn(replay.data, 'eligible'), false)
      assert.equal((await request('POST', `${path}/occurrences/1767225600000/decision`, token.plainTextToken, { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' })).status, 409)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, historical.data)
      // Synthetic matching stored-history fixture, NOT a real trusted wall-clock rewind experiment.
      // eslint-disable-next-line no-console
      console.log('PASS SYNTHETIC consistent future history permits GET exact receipt but refuses new transition without writes')
    }
    if (process.env.PATROL_REVIEW_CASE === 'expired-history' || process.env.PATROL_REVIEW_CASE === 'expired-consumed-history') {
      const a = `${path}/occurrences/1767225600000`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      const accepted = await request('POST', `${a}/decision`, token.plainTextToken, approval)
      assert.equal(accepted.status, 200)
      const consume = { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest }
      const alreadyConsumed = process.env.PATROL_REVIEW_CASE === 'expired-consumed-history'
      if (alreadyConsumed) assert.equal((await request('POST', `${a}/consume`, token.plainTextToken, consume)).status, 200)
      const { asRow } = await import('@stacksjs/database/runtime')
      const parent = asRow<{ id: number }>(await database.db.primary.selectFrom('patrol_review_schedules').select('id').where('owner_user_id', '=', user.id).where('schedule_key', '=', body.scheduleKey).executeTakeFirst())!
      const reviewedAt = '2020-01-01T00:00:01.000Z', expiresAt = '2020-01-01T00:00:03.000Z'
      await database.db.primary.updateTable('patrol_review_schedules').set({ created_at_iso: '2020-01-01T00:00:00.000Z' }).where('id', '=', parent.id).execute()
      await database.db.primary.updateTable('patrol_review_audits').set({ at_iso: '2020-01-01T00:00:00.000Z' }).where('schedule_id', '=', parent.id).where('sequence', '=', 1).execute()
      const details = { dueUtcMs: 1767225600000, scopeDigest: approval.scopeDigest, inputDigest: schedule.inputDigest, bindingDigest: schedule.bindingDigest, previousVersion: 1, resultVersion: 2, stateAfter: 'approved', expiresAt }
      await database.db.primary.updateTable('patrol_review_audits').set({ at_iso: reviewedAt, details_json: JSON.stringify(details) }).where('schedule_id', '=', parent.id).where('sequence', '=', 2).execute()
      await database.db.primary.updateTable('patrol_review_occurrences').set({ reviewed_at_iso: reviewedAt, expires_at_iso: expiresAt }).where('schedule_id', '=', parent.id).where('due_utc_ms', '=', 1767225600000).execute()
      if (alreadyConsumed) {
        const consumedAt = '2020-01-01T00:00:02.000Z'
        await database.db.primary.updateTable('patrol_review_occurrences').set({ consumed_at_iso: consumedAt }).where('schedule_id', '=', parent.id).where('due_utc_ms', '=', 1767225600000).execute()
        await database.db.primary.updateTable('patrol_review_audits').set({ at_iso: consumedAt, details_json: JSON.stringify({ ...details, previousVersion: 2, resultVersion: 3, stateAfter: 'consumed' }) }).where('schedule_id', '=', parent.id).where('sequence', '=', 3).execute()
      }
      const before = await request('GET', path, token.plainTextToken)
      assert.equal(before.status, 200)
      assert.equal(before.data.occurrences[0].state, alreadyConsumed ? 'consumed' : 'approved')
      assert.equal(Object.hasOwn(before.data, 'eligible'), false)
      const replay = await request('POST', `${a}/decision`, token.plainTextToken, approval)
      assert.equal(replay.status, 200)
      assert.equal(replay.data.replayed, true)
      assert.equal(replay.data.receipt.at, reviewedAt)
      assert.equal(replay.data.consumedNow, false)
      if (alreadyConsumed) {
        const consumedReplay = await request('POST', `${a}/consume`, token.plainTextToken, consume)
        assert.equal(consumedReplay.status, 200)
        assert.equal(consumedReplay.data.receipt.at, '2020-01-01T00:00:02.000Z')
        assert.equal(consumedReplay.data.currentVersion, 3)
        assert.equal(consumedReplay.data.replayed, true)
        assert.equal(consumedReplay.data.consumedNow, false)
      }
      else assert.equal((await request('POST', `${a}/consume`, token.plainTextToken, consume)).status, 409)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, before.data)
      // Synthetic backdated coherent ledger, NOT a wait through a genuine 120 second lease.
      // eslint-disable-next-line no-console
      console.log('PASS SYNTHETIC coherent expired approval stays historical and exact receipt readable with no fresh consumption')
    }
    if (process.env.PATROL_REVIEW_CASE === 'transition-rollback') {
      const a = `${path}/occurrences/1767225600000`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      await database.db.unsafe("CREATE TRIGGER fixture_reject_patrol_transition BEFORE INSERT ON patrol_review_audits WHEN NEW.sequence > 1 BEGIN SELECT RAISE(ABORT, 'fixture transition audit failure'); END")
      const failedReview = await request('POST', `${a}/decision`, token.plainTextToken, approval)
      assert.equal(failedReview.status, 500)
      assert.deepEqual(failedReview.data, { error: 'Patrol request failed' })
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      await database.db.unsafe('DROP TRIGGER fixture_reject_patrol_transition')
      assert.equal((await request('POST', `${a}/decision`, token.plainTextToken, approval)).status, 200)
      const approved = (await request('GET', path, token.plainTextToken)).data
      await database.db.unsafe("CREATE TRIGGER fixture_reject_patrol_transition BEFORE INSERT ON patrol_review_audits WHEN NEW.sequence > 1 BEGIN SELECT RAISE(ABORT, 'fixture transition audit failure'); END")
      const consume = { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest }
      assert.equal((await request('POST', `${a}/consume`, token.plainTextToken, consume)).status, 500)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, approved)
      await database.db.unsafe('DROP TRIGGER fixture_reject_patrol_transition')
      assert.equal((await request('POST', `${a}/consume`, token.plainTextToken, consume)).status, 200)
      // eslint-disable-next-line no-console
      console.log('PASS real audit insertion failure after each transition CAS rolls back version state and audit atomically')
    }
    if (process.env.PATROL_REVIEW_CASE === 'decision-access') {
      const a = `${path}/occurrences/1767225600000`, b = `${path}/occurrences/1767225660000`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      const reviewer = await createToken(user.id, 'review only', ['patrol:review'], { withRefreshToken: false })
      const consumer = await createToken(user.id, 'consume only', ['patrol:consume'], { withRefreshToken: false })
      assert.equal((await request('POST', `${a}/decision`, consumer.plainTextToken, '{', { 'x-fixture-unread': 'review-prebody' })).status, 403)
      assert.equal(observedBodies.get('review-prebody'), false)
      assert.equal((await request('POST', `${a}/consume`, reviewer.plainTextToken, '{', { 'x-fixture-unread': 'consume-prebody' })).status, 403)
      assert.equal(observedBodies.get('consume-prebody'), false)
      assert.equal((await request('POST', `${a}/decision`, reviewer.plainTextToken, approval)).status, 403)
      await Rbac.revokePermission(user.id, 'patrol:consume', 'web')
      assert.equal((await request('POST', `${a}/decision`, token.plainTextToken, approval)).status, 403)
      await Rbac.givePermission(user.id, 'patrol:consume', 'web')
      assert.equal((await request('POST', `${a}/decision`, token.plainTextToken, approval)).status, 200)
      const approved = (await request('GET', path, token.plainTextToken)).data
      const replacement = await createToken(user.id, 'replacement all', ['patrol:read', 'patrol:review', 'patrol:consume'], { withRefreshToken: false })
      assert.equal((await request('GET', path, replacement.plainTextToken)).status, 200)
      assert.equal((await request('POST', `${a}/decision`, replacement.plainTextToken, approval)).status, 403)
      const consume = { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest }
      assert.equal((await request('POST', `${a}/consume`, replacement.plainTextToken, consume)).status, 403)
      assert.equal((await request('POST', `${a}/consume`, consumer.plainTextToken, consume)).status, 403)
      for (const [url, value, expected] of [
        [`${b}/decision`, { ...approval, decision: 'deny', expectedVersion: 2 }, 409],
        [`${a}/decision`, { ...approval, expectedVersion: 2 }, 409],
        [`${a}/consume`, { expectedVersion: 2, requestId: approval.requestId, scopeDigest: approval.scopeDigest }, 409],
        [`${path}/occurrences/1767225600001/decision`, { ...approval, expectedVersion: 2 }, 409],
        [`${path}/occurrences/1767225600001/decision`, { ...approval, expectedVersion: 2, requestId: consume.requestId }, 404],
        [`${b}/decision`, { ...approval, expectedVersion: 2, requestId: consume.requestId, scopeDigest: '0'.repeat(64) }, 409],
        [`${a}/consume`, { ...consume, expectedVersion: 1 }, 409],
        [`${a}/consume`, { ...consume, actorId: user.id }, 422],
        [`${a}/decision`, { ...approval, requestId: consume.requestId, decision: 'approve ', expectedVersion: 2 }, 422],
        [`${path}/occurrences/01767225600000/decision`, approval, 422],
        [`${a}/consume?extra=1`, consume, 422],
      ] as const) assert.equal((await request('POST', url, token.plainTextToken, value)).status, expected)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, approved)
      const { authCookieName } = await import('@stacksjs/auth/cookie')
      assert.equal((await request('POST', `${a}/consume`, null, consume, { cookie: `${authCookieName()}=${token.plainTextToken}` })).status, 403)
      const consumed = await request('POST', `${a}/consume`, token.plainTextToken, consume)
      assert.equal(consumed.status, 200)
      assert.equal(consumed.data.consumedNow, true)
      assert.equal((await request('POST', `${a}/consume`, replacement.plainTextToken, consume)).status, 403)
      assert.equal((await request('POST', `${b}/decision`, replacement.plainTextToken, { ...approval, requestId: '44444444-4444-4444-8444-444444444444', expectedVersion: 3, scopeDigest: schedule.occurrences[1].scopeDigest, decision: 'deny' })).status, 200)
      // eslint-disable-next-line no-console
      console.log('PASS current review consume grants and original token enforce request namespace without adoption or private projection')
    }
    if (process.env.PATROL_REVIEW_CASE === 'consume') {
      const decisionPath = `${path}/occurrences/1767225600000/decision`, consumePath = `${path}/occurrences/1767225600000/consume`
      const approval = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'approve' }
      const approved = await request('POST', decisionPath, token.plainTextToken, approval)
      assert.equal(approved.status, 200)
      const afterReview = (await request('GET', path, token.plainTextToken)).data
      assert.equal(afterReview.occurrences[0].state, 'approved')
      assert.equal(Date.parse(afterReview.occurrences[0].expiresAt) - Date.parse(afterReview.occurrences[0].reviewedAt), 120000)
      const consume = { expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: approval.scopeDigest }
      const consumed = await request('POST', consumePath, token.plainTextToken, consume)
      assert.equal(consumed.status, 200)
      assert.equal(consumed.data.consumedNow, true)
      assert.equal(consumed.data.currentVersion, 3)
      assert.equal(consumed.data.receipt.action, 'consumed')
      assert.equal(consumed.data.launchAuthorized, false)
      const final = (await request('GET', path, token.plainTextToken)).data
      assert.equal(final.occurrences[0].state, 'consumed')
      assert.equal(final.occurrences[0].reviewRequestId, approval.requestId)
      assert.equal(final.occurrences[0].consumeRequestId, consume.requestId)
      const denied = await request('POST', `${path}/occurrences/1767225660000/decision`, token.plainTextToken, { ...approval, expectedVersion: 3, requestId: '44444444-4444-4444-8444-444444444444', scopeDigest: schedule.occurrences[1].scopeDigest, decision: 'deny' })
      assert.equal(denied.status, 200)
      for (const [routePath, payload, original] of [[decisionPath, approval, approved], [consumePath, consume, consumed], ['/api/patrol/reviews', body, { data: receipt }]] as const) {
        const replay = await request('POST', routePath, token.plainTextToken, payload)
        assert.equal(replay.status, 200)
        assert.equal(replay.data.replayed, true)
        assert.equal(replay.data.consumedNow, false)
        assert.equal(replay.data.currentVersion, 4)
        assert.deepEqual(replay.data.receipt, original.data.receipt)
      }
      const current = (await request('GET', path, token.plainTextToken)).data
      assert.deepEqual(current.audit.map((a: { action: string }) => a.action), ['created', 'approved', 'consumed', 'denied'])
      assert.equal((await request('POST', consumePath, token.plainTextToken, { ...consume, expectedVersion: 4, requestId: '55555555-5555-4555-8555-555555555555' })).status, 409)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, current)
      // eslint-disable-next-line no-console
      console.log('PASS native approval consumption and later denial preserve all exact historical receipts without execution')
    }
    if (process.env.PATROL_REVIEW_CASE === 'denial') {
      const reviewer = await createToken(user.id, 'deny without consume', ['patrol:review'], { withRefreshToken: false })
      const decisionPath = `${path}/occurrences/1767225600000/decision`
      const decision = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: schedule.occurrences[0].scopeDigest, decision: 'deny' }
      const denied = await request('POST', decisionPath, reviewer.plainTextToken, decision)
      assert.equal(denied.status, 200)
      assert.equal(denied.data.receipt.action, 'denied')
      assert.equal(denied.data.currentVersion, 2)
      assert.equal(denied.data.consumedNow, false)
      const current = await request('GET', path, token.plainTextToken)
      assert.equal(current.status, 200)
      assert.equal(current.data.occurrences[0].state, 'denied')
      assert.equal(current.data.occurrences[0].expiresAt, null)
      assert.deepEqual(current.data.audit.map((a: { action: string }) => a.action), ['created', 'denied'])
      const replay = await request('POST', decisionPath, reviewer.plainTextToken, decision)
      assert.equal(replay.status, 200)
      assert.equal(replay.data.replayed, true)
      assert.deepEqual(replay.data.receipt, denied.data.receipt)
      assert.equal((await request('POST', decisionPath, reviewer.plainTextToken, { ...decision, requestId: '33333333-3333-4333-8333-333333333333', expectedVersion: 2, decision: 'approve' })).status, 403)
      assert.equal((await request('POST', decisionPath, token.plainTextToken, { ...decision, requestId: '33333333-3333-4333-8333-333333333333', expectedVersion: 2, decision: 'approve' })).status, 409)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, current.data)
      // eslint-disable-next-line no-console
      console.log('PASS native deny-only reviewer commits terminal denial and exact receipt without consume privileges')
    }
    if (process.env.PATROL_REVIEW_CASE === 'access') {
      const outsider = await User.create({ name: 'Other Owner', email: 'other-owner@example.invalid', password: 'temporary-fixture-password' })
      for (const name of ['patrol:access', 'patrol:create', 'patrol:read']) await Rbac.givePermission(outsider.id, name, 'web')
      const other = await createToken(outsider.id, 'other owner', ['patrol:create', 'patrol:read'], { withRefreshToken: false })
      assert.equal((await request('GET', path, other.plainTextToken)).status, 404)
      assert.equal((await request('POST', '/api/patrol/reviews', null, '{', { 'x-fixture-unread': 'no-auth' })).status, 401)
      assert.equal(observedBodies.get('no-auth'), false)
      const readOnly = await createToken(user.id, 'read only', ['patrol:read'], { withRefreshToken: false })
      assert.equal((await request('POST', '/api/patrol/reviews', readOnly.plainTextToken, '{', { 'x-fixture-unread': 'no-create-scope' })).status, 403)
      assert.equal(observedBodies.get('no-create-scope'), false)
      await Rbac.revokePermission(user.id, 'patrol:create', 'web')
      assert.equal((await request('POST', '/api/patrol/reviews', token.plainTextToken, '{', { 'x-fixture-unread': 'no-create-permission' })).status, 403)
      assert.equal(observedBodies.get('no-create-permission'), false)
      await Rbac.givePermission(user.id, 'patrol:create', 'web')
      const { authCookieName } = await import('@stacksjs/auth/cookie')
      assert.equal((await request('GET', path, null, undefined, { cookie: `${authCookieName()}=${token.plainTextToken}` })).status, 200)
      assert.equal((await request('POST', '/api/patrol/reviews', null, body, { cookie: `${authCookieName()}=${token.plainTextToken}`, 'x-fixture-unread': 'csrf' })).status, 403)
      assert.equal(observedBodies.get('csrf'), false)
      const replay = await request('POST', '/api/patrol/reviews', token.plainTextToken, body)
      assert.equal(replay.status, 200)
      assert.equal(replay.data.replayed, true)
      assert.equal(replay.data.consumedNow, false)
      assert.deepEqual(replay.data.receipt, receipt.receipt)
      const replacement = await createToken(user.id, 'replacement', ['patrol:create', 'patrol:read'], { withRefreshToken: false })
      assert.equal((await request('GET', path, replacement.plainTextToken)).status, 200)
      assert.equal((await request('POST', '/api/patrol/reviews', replacement.plainTextToken, body)).status, 403)
      assert.equal((await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, binding: { ...body.binding, sessionId: '124' } })).status, 409)
      assert.equal((await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, actorId: outsider.id })).status, 422)
      assert.equal((await request('GET', `${path}?extra=1`, token.plainTextToken)).status, 422)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      const separate = await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, scheduleKey: 'same-uuid-other-key' })
      assert.equal(separate.status, 201)
      const createOnly = await createToken(user.id, 'create only', ['patrol:create'], { withRefreshToken: false })
      const privateMutation = await request('POST', '/api/patrol/reviews', createOnly.plainTextToken, { ...body, scheduleKey: 'create-without-read' })
      assert.equal(privateMutation.status, 201)
      for (const field of ['input', 'binding', 'ownerUserId', 'audit', 'requestDigest', 'tokenId']) assert.equal(Object.hasOwn(privateMutation.data, field), false)
      assert.equal((await request('GET', '/api/patrol/reviews/create-without-read', createOnly.plainTextToken)).status, 403)
      for (const generic of ['/models/PatrolReviewSchedule', '/dashboard/models/PatrolReviewAudit', '/api/dashboard/models/PatrolReviewOccurrence']) {
        const response = await fetch(`http://127.0.0.1:${server.port}${generic}`, { headers })
        assert.equal(response.status, 404)
      }
      // eslint-disable-next-line no-console
      console.log('PASS native patrol current access, private projections, canonical intent and original-token create receipts')
    }
    if (process.env.PATROL_REVIEW_CASE === 'invalid-primitives') {
      for (const [label, changed] of [
        ['request-id-carriage-return', { requestId: `${body.requestId}\r` }],
        ['request-id-line-separator', { requestId: `${body.requestId}\u2028` }],
        ['key-paragraph-separator', { scheduleKey: 'bad-key\u2029' }],
        ['request-id-newline', { requestId: `${body.requestId}\n` }],
        ['schedule-key-newline', { scheduleKey: 'bad-key\n' }],
        ['event-id-newline', { input: { ...body.input, decisions: [{ ...body.input.decisions[0], id: 'first\n' }, body.input.decisions[1]] } }],
        ['session-newline', { binding: { ...body.binding, sessionId: '123\n' } }],
        ['boot-newline', { binding: { ...body.binding, bootId: '55\n', reference: '55\n:0,0,0,0,0' } }],
        ['reset-newline', { binding: { ...body.binding, reference: '55:0,0,0,0,0\n' } }],
        ['intermediate-due', { input: { ...body.input, decisions: [{ ...body.input.decisions[0], dueUtcMs: 1767225600001 }] } }],
        ['alternate-origin', { binding: { ...body.binding, origin: '{"longitudeDeg":0,"latitudeDeg":0,"ellipsoidHeightM":100}' } }],
      ] as const) {
        const current = await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, scheduleKey: `invalid-${label}`, ...changed })
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ label, status: current.status }))
        assert.equal(current.status, 422)
      }
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      // eslint-disable-next-line no-console
      console.log('PASS native patrol exact primitive boundaries reject trailing newline and nonselected frames')
    }
    if (process.env.PATROL_REVIEW_CASE === 'corruption') {
      const { asRow } = await import('@stacksjs/database/runtime')
      const parent = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_schedules').selectAll().where('owner_user_id', '=', user.id).where('schedule_key', '=', body.scheduleKey).executeTakeFirst())!
      const occurrence = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_occurrences').selectAll().where('schedule_id', '=', parent.id).orderBy('due_utc_ms', 'asc').executeTakeFirst())!
      const audit = asRow<Record<string, unknown>>(await database.db.primary.selectFrom('patrol_review_audits').selectAll().where('schedule_id', '=', parent.id).executeTakeFirst())!
      for (const [table, row, field, changed] of [
        ['patrol_review_occurrences', occurrence, 'due_utc_ms', 1767225600001],
        ['patrol_review_schedules', parent, 'created_at_iso', '2026-02-30T00:00:00.000Z'],
        ['patrol_review_schedules', parent, 'input_json', ` ${parent.input_json}`],
        ['patrol_review_schedules', parent, 'input_json', ' '.repeat(1025) + parent.input_json],
        ['patrol_review_schedules', parent, 'binding_json', ' '.repeat(1025) + parent.binding_json],
        ['patrol_review_audits', audit, 'details_json', ' '.repeat(513) + audit.details_json],
      ] as const) {
        await database.db.primary.updateTable(table).set({ [field]: changed }).where('id', '=', row.id).execute()
        assert.equal((await request('GET', path, token.plainTextToken)).status, 500)
        const unchanged = asRow<Record<string, unknown>>(await database.db.primary.selectFrom(table).selectAll().where('id', '=', row.id).executeTakeFirst())!
        assert.equal(unchanged[field], changed)
        await database.db.primary.updateTable(table).set({ [field]: row[field] }).where('id', '=', row.id).execute()
        assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      }
      // eslint-disable-next-line no-console
      console.log('PASS native patrol corrupt stored dates, due tuples and raw JSON bounds refuse without read repair')
    }
    if (process.env.PATROL_REVIEW_CASE === 'quota') {
      for (let n = 1; n < 16; n++) {
        const scheduleKey = `quota-${n}`
        const created = await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, scheduleKey })
        assert.equal(created.status, 201)
        const current = await request('GET', `/api/patrol/reviews/${scheduleKey}`, token.plainTextToken)
        assert.equal(current.status, 200)
        assert.equal(current.data.occurrences.length, 2)
        assert.equal(current.data.audit.length, 1)
      }
      assert.equal((await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, scheduleKey: 'seventeenth' })).status, 409)
      assert.equal((await request('GET', '/api/patrol/reviews/seventeenth', token.plainTextToken)).status, 404)
      const replay = await request('POST', '/api/patrol/reviews', token.plainTextToken, body)
      assert.equal(replay.status, 200)
      assert.equal(replay.data.replayed, true)
      assert.equal(replay.data.currentVersion, 1)
      const { asRows } = await import('@stacksjs/database/runtime')
      const rows = asRows(await database.db.primary.selectFrom('patrol_review_schedules').select('id').where('owner_user_id', '=', user.id).execute())
      assert.equal(rows.length, 16)
      // eslint-disable-next-line no-console
      console.log('PASS native single-process sixteen-schedule capacity and exact creation receipt at capacity')
    }
    if (process.env.PATROL_REVIEW_CASE === 'rollback') {
      await database.db.unsafe("CREATE TRIGGER fixture_reject_patrol_audit BEFORE INSERT ON patrol_review_audits BEGIN SELECT RAISE(ABORT, 'fixture audit insert failure'); END")
      const failed = await request('POST', '/api/patrol/reviews', token.plainTextToken, { ...body, scheduleKey: 'audit-fails' })
      assert.equal(failed.status, 500)
      assert.deepEqual(failed.data, { error: 'Patrol request failed' })
      assert.equal((await request('GET', '/api/patrol/reviews/audit-fails', token.plainTextToken)).status, 404)
      assert.deepEqual((await request('GET', path, token.plainTextToken)).data, schedule)
      const { asRows } = await import('@stacksjs/database/runtime')
      for (const [table, count] of [['patrol_review_schedules', 1], ['patrol_review_occurrences', 2], ['patrol_review_audits', 1]] as const) assert.equal(asRows(await database.db.primary.selectFrom(table).selectAll().execute()).length, count)
      // eslint-disable-next-line no-console
      console.log('PASS actual audit INSERT failure rolls back patrol schedule and both occurrence rows')
    }
    // eslint-disable-next-line no-console
    console.log('PASS native patrol create and owner read without execution')
  }
  finally {
    await server.stop(true)
    await database.closeDatabaseConnection()
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
