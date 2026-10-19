import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { database, actor, as, seed, status, managed, access, retention, Rbac } from './managed-context'
const onlyFence = process.argv[2]
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
const summary = (key: string) => writer.query('SELECT a.*, i.version AS actual_incident_version FROM public_safety_managed_artifacts a JOIN public_safety_incidents i ON i.id=a.incident_id WHERE i.incident_key=? ORDER BY a.id DESC').all(key)[0] as { artifact_key: string, state: string, version: number, actual_incident_version: number, receipt_json: string | null, target_path: string }
const payloadState = (target: string) => readdirSync(target, { recursive: true }).map(value => { const path = join(target, String(value)); return [String(value), lstatSync(path).size, lstatSync(path).isFile()] })
try {
  const coordinator = await actor('managed-critical')
  const token = coordinator.token.plainTextToken
  await as(token, async () => {
    for (const stage of ['prepared', 'complete'] as const) for (const method of ['close', 'reset'] as const) {
      if (onlyFence !== `${stage}-${method}`) continue
      const key = `fence-${stage}-${method}`, fixture = await seed(key)
      let fired = 0, closing: Promise<void> | undefined
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (fired || !sql.startsWith('update public_safety_managed_artifacts') || !event.params?.includes(stage)) return
        fired++
        queueMicrotask(() => { if (method === 'close') closing = database.closeDatabaseConnection(); else database.resetDatabaseConnection() })
      } })
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(409)) }
      finally { unhook(); await closing }
      assert.equal(fired, 1)
      const row = summary(key)
      assert.equal(row.state, stage === 'prepared' ? 'intent' : 'prepared')
      assert.equal(row.version, stage === 'prepared' ? 1 : 2)
      assert.equal(row.actual_incident_version, stage === 'prepared' ? 4 : 5)
      if (stage === 'prepared') assert(!existsSync(row.target_path))
      else {
        assert(row.receipt_json)
        assert(payloadState(row.target_path).filter(entry => entry[2]).every(entry => entry[1] === 0))
        assert(!existsSync(join(row.target_path, 'manifest.json')))
      }
      console.log(`PASS actual B ${stage} ${method} refuses late synchronous filesystem stage`)
    }
    if (onlyFence) return
    for (const stage of ['prepared', 'complete'] as const) {
      const key = `deadline-${stage}`, fixture = await seed(key, 10000)
      let fired = 0
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (fired || !sql.startsWith('update public_safety_managed_artifacts') || !event.params?.includes(stage)) return
        fired++
        // Genuine wall time passes after the awaited native CAS, no clock/Auth/ORM mock.
        const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 5
        if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
      } })
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(404)) }
      finally { unhook() }
      assert.equal(fired, 1)
      const row = summary(key)
      if (stage === 'prepared') assert(!existsSync(row.target_path))
      else assert(payloadState(row.target_path).filter(entry => entry[2]).every(entry => entry[1] === 0))
      console.log(`PASS actual B ${stage} checks wall-clock expiry directly before FS`)
    }
    for (const step of ['ownership-recorded', 'published'] as const) {
      const key = `rollback-${step}`, fixture = await seed(key)
      writer.exec(`CREATE TRIGGER fail_managed_event BEFORE INSERT ON public_safety_managed_artifact_events WHEN NEW.action='${step}' BEGIN SELECT RAISE(ABORT,'fixture SQL failure'); END`)
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(409)) }
      finally { writer.exec('DROP TRIGGER fail_managed_event') }
      const row = summary(key), before = payloadState(row.target_path)
      assert.equal(row.state, step === 'ownership-recorded' ? 'intent' : 'prepared')
      assert.equal(row.actual_incident_version, step === 'ownership-recorded' ? 4 : 5)
      const completed = existsSync(join(row.target_path, 'manifest.json'))
      assert.equal(completed, step === 'published')
      if (!completed) assert(before.filter(entry => entry[2]).every(entry => entry[1] === 0))
      const replay = await managed.createPublicSafetyManagedDataset(key, fixture.body)
      assert.equal(replay.replayed, true)
      assert.equal(replay.artifact.state, row.state)
      assert.deepEqual(payloadState(row.target_path), before, 'retry does not republish or adopt files')
      const reconciled = await managed.reconcilePublicSafetyManagedArtifact(key, row.artifact_key, { expectedVersion: row.actual_incident_version, expectedArtifactVersion: row.version, requestId: randomUUID() })
      assert.equal(reconciled.artifact.state, step === 'published' ? 'complete' : 'blocked')
      assert.deepEqual(payloadState(row.target_path), before, 'reconcile is read-only, including unknown zero preparation')
      console.log(`PASS actual B ${step} real SQL rollback preserves recoverable physical outcome`)
    }
    const fixture = await seed('late-download')
    const created = await managed.createPublicSafetyManagedDataset('late-download', fixture.body)
    const read = await managed.readPublicSafetyManagedArtifact('late-download', created.artifact.key), selected = read.files.find(file => file.role === 'recording')!
    const permission = writer.query("SELECT id FROM permissions WHERE name='public-safety:access' AND guard_name='web'").get() as { id: number }
    const incidentId = writer.query('SELECT id FROM public_safety_incidents WHERE incident_key=?').get('late-download') as { id: number }
    for (const change of ['token', 'permission', 'membership'] as const) {
      let fired = 0
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (fired || !sql.startsWith('select') || !sql.includes('from public_safety_managed_artifact_files')) return
        fired++
        if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked=1 WHERE id=?').run(coordinator.token.accessToken.id)
        if (change === 'permission') writer.query('DELETE FROM user_permissions WHERE user_id=? AND permission_id=?').run(coordinator.user.id, permission.id)
        if (change === 'membership') writer.query('UPDATE public_safety_incident_members SET active=0 WHERE incident_id=? AND user_id=?').run(incidentId.id, coordinator.user.id)
      } })
      try { await assert.rejects(() => managed.readPublicSafetyManagedArtifactFile('late-download', created.artifact.key, selected.id), status(change === 'token' ? 401 : 403)) }
      finally {
        unhook()
        if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked=0 WHERE id=?').run(coordinator.token.accessToken.id)
        if (change === 'permission') await Rbac.givePermission(coordinator.user.id, 'public-safety:access', 'web')
        if (change === 'membership') writer.query('UPDATE public_safety_incident_members SET active=1 WHERE incident_id=? AND user_id=?').run(incidentId.id, coordinator.user.id)
      }
      assert.equal(fired, 1)
      assert.equal((await managed.readPublicSafetyManagedArtifact('late-download', created.artifact.key)).artifact.version, 3)
      console.log(`PASS actual B download rechecks ${change} after staged file read`)
    }
    for (const phase of ['staged', 'prepared', 'complete'] as const) for (const change of ['token', 'permission', 'membership', 'closed'] as const) {
      const key = `fresh-${phase}-${change}`, current = await seed(key)
      const row = writer.query('SELECT id FROM public_safety_incidents WHERE incident_key=?').get(key) as { id: number }
      let lastAction = '', fired = 0
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('insert into public_safety_managed_artifact_events')) for (const action of ['intent-recorded', 'ownership-recorded']) if (event.params?.includes(action)) lastAction = action
        const staged = phase === 'staged' && sql.startsWith('select') && sql.includes('canonical_json') && sql.includes('from public_safety_sources')
        const committed = sql.startsWith('select distinct permissions') && (phase === 'prepared' && lastAction === 'intent-recorded' || phase === 'complete' && lastAction === 'ownership-recorded')
        if (fired || !staged && !committed) return
        fired++
        if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked=1 WHERE id=?').run(coordinator.token.accessToken.id)
        if (change === 'permission') writer.query('DELETE FROM user_permissions WHERE user_id=? AND permission_id=?').run(coordinator.user.id, permission.id)
        if (change === 'membership') writer.query('UPDATE public_safety_incident_members SET active=0 WHERE incident_id=? AND user_id=?').run(row.id, coordinator.user.id)
        if (change === 'closed') writer.query("UPDATE public_safety_incidents SET status='closed', version=version+1 WHERE id=?").run(row.id)
      } })
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, current.body), error => error instanceof access.PublicSafetyAccessError && [401, 403, 409].includes(error.status)) }
      finally {
        unhook()
        if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked=0 WHERE id=?').run(coordinator.token.accessToken.id)
        if (change === 'permission') await Rbac.givePermission(coordinator.user.id, 'public-safety:access', 'web')
        if (change === 'membership') writer.query('UPDATE public_safety_incident_members SET active=1 WHERE incident_id=? AND user_id=?').run(row.id, coordinator.user.id)
      }
      assert.equal(fired, 1)
      const outcome = summary(key)
      if (phase === 'staged') assert.equal(outcome, undefined, 'authority loss after source staging leaves no durable intent')
      else {
        assert.equal(outcome.state, phase === 'prepared' ? 'intent' : 'prepared')
        if (phase === 'prepared') assert(!existsSync(outcome.target_path))
        else assert(payloadState(outcome.target_path).filter(entry => entry[2]).every(entry => entry[1] === 0))
      }
      console.log(`PASS actual persisted ${change} after ${phase} refuses later managed FS stage`)
    }
    for (const field of ['byte_length', 'digest', 'incident_id'] as const) {
      const key = `binding-${field.replaceAll('_', '-')}`, current = await seed(key), alternate = await seed(`${key}-other`)
      let fired = 0
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (fired || !sql.startsWith('select') || !sql.includes('canonical_json') || !sql.includes('from public_safety_sources')) return
        fired++
        const replacement = field === 'byte_length' ? current.source.byteLength + 1 : field === 'digest' ? 'f'.repeat(64) : (writer.query('SELECT id FROM public_safety_incidents WHERE incident_key=?').get(alternate.config.id) as { id: number }).id
        writer.query(`UPDATE public_safety_sources SET ${field}=? WHERE digest=?`).run(replacement, current.source.digest)
      } })
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, current.body), status(409)) }
      finally { unhook() }
      assert.equal(fired, 1); assert.equal(summary(key), undefined)
      console.log(`PASS managed staged source metadata ${field} drift refuses intent before FS`)
    }
    const profile = await seed('binding-profile-constraint')
    assert.throws(() => writer.query('UPDATE public_safety_sources SET replay_profile=? WHERE digest=?').run('unqualified-profile', profile.source.digest), /CHECK constraint/)
    assert.equal(summary(profile.config.id), undefined)
    console.log('PASS native source schema rejects unsupported replay profile without changing source or intent')
    const race = await seed('managed-race')
    const attempts = await Promise.allSettled([managed.createPublicSafetyManagedDataset('managed-race', race.body), managed.createPublicSafetyManagedDataset('managed-race', { ...race.body, requestId: randomUUID() })])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await managed.listPublicSafetyManagedArtifacts('managed-race')).entries.length, 1)
    assert.equal((await access.readPublicSafetyIncident('managed-race')).version, 6)
    assert.equal((await retention.readPublicSafetyRetention('managed-race')).version, 1)
    console.log('PASS actual B two intentional creates have one initial CAS winner')
  })
  console.log('PASS actual B critical fences, expiry, SQL rollback, late read authorization and CAS')
}
finally { writer.close(); await database.closeDatabaseConnection() }
