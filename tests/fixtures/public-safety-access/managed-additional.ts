import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { database, actor, as, seed, status, managed, access, retention, records } from './managed-context'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
const rowFor = (key: string) => writer.query('SELECT a.*, i.version AS incident_version FROM public_safety_managed_artifacts a JOIN public_safety_incidents i ON i.id=a.incident_id WHERE i.incident_key=?').get(key) as { artifact_key: string, id: number, state: string, version: number, incident_version: number, target_path: string } | null
try {
  const coordinator = await actor('additional-coordinator'), member = await actor('additional-member')
  await as(coordinator.token.plainTextToken, async () => {
    for (const stage of ['prepared', 'complete'] as const) for (const mismatch of ['nonce', 'phase', 'generation'] as const) {
      const key = `f-${stage === 'prepared' ? 'p' : 'c'}-${mismatch}`, fixture = await seed(key)
      const alter = mismatch === 'nonce' ? "operation_nonce='different-native-nonce'" : mismatch === 'phase' ? "state='blocked'" : 'generation=generation+1'
      writer.exec(`CREATE TRIGGER alter_managed_continuity AFTER UPDATE OF state ON public_safety_managed_artifacts WHEN NEW.state='${stage}' AND OLD.state!='${stage}' BEGIN UPDATE public_safety_managed_artifacts SET ${alter} WHERE id=NEW.id; END`)
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(409)) }
      finally { writer.exec('DROP TRIGGER alter_managed_continuity') }
      const row = rowFor(key)!
      assert.equal(row.state, stage === 'prepared' ? 'intent' : 'prepared'); assert.equal(row.version, stage === 'prepared' ? 1 : 2)
      assert.equal(row.incident_version, stage === 'prepared' ? 4 : 5)
      if (stage === 'prepared') assert(!existsSync(row.target_path))
      else {
        const files = readdirSync(row.target_path, { recursive: true }).map(name => join(row.target_path, String(name))).filter(path => lstatSync(path).isFile())
        assert(files.every(path => lstatSync(path).size === 0)); assert(!existsSync(join(row.target_path, 'manifest.json')))
      }
      console.log(`PASS actual SQLite ${mismatch} mismatch at ${stage} refuses synchronous FS and rolls back transition`)
    }
    const staged = await seed('staged-config')
    let fired = 0
    const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (fired || !sql.startsWith('select') || !sql.includes('canonical_json') || !sql.includes('from public_safety_sources')) return
      fired++
      // Privileged external SQL drift, not an authenticated config-edit API.
      writer.query('UPDATE public_safety_incidents SET config_json=? WHERE incident_key=?').run(publicSafetyRecordingData({ ...staged.config, policyId: 'changed-staged-policy' }), staged.config.id)
    } })
    try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(staged.config.id, staged.body), status(409)) }
    finally { unhook() }
    assert.equal(fired, 1); assert.equal(rowFor(staged.config.id), null)
    console.log('PASS actual staged canonical incident config drift refuses intent before filesystem effects')
    for (const other of ['close', 'membership', 'observation', 'hold'] as const) {
      const fixture = await seed(`mixed-managed-${other}`), key = fixture.config.id
      const originalScope = await retention.readPublicSafetyRetention(key)
      const mutation = () => other === 'close'
        ? access.closePublicSafetyIncident(key, { expectedVersion: 3 })
        : other === 'membership'
          ? access.changePublicSafetyMembership(key, { expectedVersion: 3, userId: member.user.id, role: 'observer' })
          : other === 'hold'
            ? retention.reviewPublicSafetyRetentionHold(key, { expectedRetentionVersion: 1, decision: 'retain', caseReference: 'mixed:fixture', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() })
            : (() => {
                const index = fixture.run.captures[0]!.support.findIndex(value => value === 1), capture = fixture.run.survey.captures[0]!
                assert(index >= 0)
                return records.appendPublicSafetyObservation(key, { expectedVersion: 3, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: index % capture.width, y: Math.floor(index / capture.width) }, note: 'actual mixed mutation', uncertaintyNote: 'synthetic fixture' })
              })()
      const results = await Promise.allSettled([managed.createPublicSafetyManagedDataset(key, fixture.body), mutation()])
      for (const result of results) if (result.status === 'rejected') assert(result.reason instanceof access.PublicSafetyAccessError && result.reason.status === 409)
      const artifact = rowFor(key), current = await access.readPublicSafetyIncident(key)
      const eventCount = artifact ? Number((writer.query('SELECT count(*) AS n FROM public_safety_managed_artifact_events WHERE artifact_id=?').get(artifact.id) as { n: number }).n) : 0
      const otherCommitted = results[1]!.status === 'fulfilled'
      if (other !== 'hold') assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'same expected common-version mutations have one initial CAS winner')
      else assert(otherCommitted, 'hold mutation uses its independent current retention sequence')
      assert.equal(current.version, 3 + eventCount + Number(otherCommitted), 'each committed lifecycle/other event advances common version exactly once')
      const scope = await retention.readPublicSafetyRetention(key)
      assert.equal(scope.version, originalScope.version + Number(other === 'hold' && otherCommitted))
      if (artifact) {
        const events = await managed.listPublicSafetyManagedArtifactEvents(key, artifact.artifact_key)
        assert.deepEqual(events.entries.map(event => event.sequence), Array.from({ length: eventCount }, (_, index) => index + 1))
        assert.equal(artifact.version, eventCount)
      }
      console.log(`PASS actual public managed/${other} CAS race accounts for each committed version and independent hold sequence`)
    }
  })
  console.log('PASS additional native continuity, staged config and mixed public CAS qualification')
}
finally { writer.close(); await database.closeDatabaseConnection() }
