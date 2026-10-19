import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { actor, as, seed, database, managed, records, retention, access, status, root } from './managed-context'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const kinds = ['source', 'observation', 'review', 'member', 'managed', 'hold'] as const
const tables = ['public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_retention_events', 'public_safety_managed_artifacts', 'public_safety_managed_artifact_files', 'public_safety_managed_artifact_events']
const savedPath = join(root, 'mixed-race.json'), mode = process.argv[2], kind = process.argv[3]
async function payloadRows() { return Promise.all(tables.map(table => database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute())) }
function namespace() {
  const directory = process.env.PUBLIC_SAFETY_MANAGED_ROOT!
  return ['', ...readdirSync(directory, { recursive: true }).map(String).sort()].map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true })
    return [name, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), String(stat.mode), String(stat.uid), String(stat.size), stat.isFile() ? readFileSync(path).toString('base64') : null]
  })
}
async function waitFor(name: string) {
  const deadline = Date.now() + 60000
  while (!existsSync(join(root, name)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert(existsSync(join(root, name)), `Missing actual process rendezvous ${name}`)
}
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  if (mode === 'create') {
    const coordinator = await actor('mixed-race-coordinator'), observer = await actor('mixed-race-observer')
    await as(coordinator.token.plainTextToken, async () => {
      const key = 'purge-mixed-race', fixture = await seed(key, 20000), rollbackNow = Date.now()
      const second = await records.registerPublicSafetySource(key, { expectedVersion: 3, recording: simulatePublicSafety({ config: fixture.config, seconds: 11 }) })
      const capture = fixture.run.survey.captures[0]!, support = fixture.run.captures[0]!.support.findIndex(value => value === 1)
      const observationBody = { expectedVersion: 4, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible' as const, pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private-parallel-observation', uncertaintyNote: 'private-parallel-uncertainty' }
      const observation = await records.appendPublicSafetyObservation(key, observationBody)
      const review = await records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion: 5, sourceDigest: fixture.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'private-parallel-review' })
      await access.changePublicSafetyMembership(key, { expectedVersion: 6, userId: observer.user.id, role: 'observer' })
      await managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion: 7 })
      const recording = simulatePublicSafety({ config: fixture.config, seconds: 12 }), digest = createHash('sha256').update(publicSafetyRecordingData(recording)).digest('hex')
      assert(![fixture.source.digest, second.source.digest].includes(digest))
      const sources = await database.db.primary.selectFrom('public_safety_sources').select('digest').execute()
      assert.equal(sources.length, 2); assert(sources.every(row => row.digest !== digest))
      writeFileSync(savedPath, JSON.stringify({ key, token: coordinator.token.plainTextToken, observerId: observer.user.id, rollbackNow, expiresAt: fixture.config.retention.expiresAt, sourceDigest: fixture.source.digest, recording: JSON.parse(publicSafetyRecordingData(recording)), recordingDigest: digest, observationBody, observationId: observation.observation.id, reviewId: review.review.id, managedBody: fixture.body, expectedVersion: 10, expectedRetentionVersion: 1, rows: await payloadRows(), namespace: namespace() }))
    })
  }
  else {
    const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
    await as(saved.token, async () => {
      if (mode === 'writer') {
        assert(kinds.includes(kind as typeof kinds[number]))
        // Resolve native Auth and entitlement before C holds its SQLite writer. This avoids token last_used_at contention masquerading as a public command CAS.
        const { Auth } = await import('@stacksjs/auth/authentication'); assert(await Auth.user()); await access.readPublicSafetyIncident(saved.key)
        writeFileSync(join(root, `mixed-ready-${kind}`), 'native-auth-ready')
        await waitFor('mixed-acceptor-stopped-confirmed')
        const originalNow = Date.now
        let publicWriteAttempted = false
        const unhook = registerPersistentQueryHooks({ onQueryStart(event) {
          const sql = event.sql.replace(/["`]/g, '').toLowerCase()
          if (/^(update|insert into) public_safety_/.test(sql)) publicWriteAttempted = true
        } })
        async function command(expectedVersion: number, expectedRetentionVersion: number) {
          if (kind === 'source') { assert.equal(createHash('sha256').update(publicSafetyRecordingData(saved.recording)).digest('hex'), saved.recordingDigest); return records.registerPublicSafetySource(saved.key, { expectedVersion, recording: saved.recording }) }
          if (kind === 'observation') return records.appendPublicSafetyObservation(saved.key, { ...saved.observationBody, expectedVersion })
          if (kind === 'review') return records.appendPublicSafetyReview(saved.key, saved.observationId, { expectedVersion, sourceDigest: saved.sourceDigest, previousReviewId: saved.reviewId, disposition: 'unresolved', note: 'controlled-parallel-review' })
          if (kind === 'member') return access.changePublicSafetyMembership(saved.key, { expectedVersion, userId: saved.observerId, role: 'pilot' })
          if (kind === 'managed') return managed.createPublicSafetyManagedDataset(saved.key, { ...saved.managedBody, expectedVersion, expectedRetentionVersion, requestId: randomUUID() })
          if (kind === 'hold') return retention.reviewPublicSafetyRetentionHold(saved.key, { expectedRetentionVersion, decision: 'retain', caseReference: 'controlled-parallel-hold', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() })
          throw new Error('Unknown mixed public writer')
        }
        try {
          // Explicit controlled clock rollback only in the competing writer. The accepting process uses genuine due wall time.
          Date.now = () => saved.rollbackNow
          await assert.rejects(() => command(saved.expectedVersion, saved.expectedRetentionVersion), error => status(409)(error) || error instanceof Error && /locked|busy/i.test(error.message))
          assert(publicWriteAttempted, `${kind} must reach a real native public write attempt while C owns SQLite CAS`)
          assert.deepEqual(await payloadRows(), saved.rows); assert.deepEqual(namespace(), saved.namespace)
          assert.equal((await database.db.primary.selectFrom('public_safety_purges').select('id').execute()).length, 0, 'Acceptance remains uncommitted while the real acceptor is OS stopped')
          writeFileSync(join(root, `mixed-held-result-${kind}`), JSON.stringify({ publicWriteAttempted, held: true }))
          // Restore the real clock for bounded process coordination, then reapply only around the fresh public call.
          Date.now = originalNow
          await waitFor('mixed-acceptance-commit-confirmed')
          const incident = (await database.db.primary.selectFrom('public_safety_incidents').select(['id', 'version']).where('incident_key', '=', saved.key).executeTakeFirst())!
          const scope = (await database.db.primary.selectFrom('public_safety_retention_scopes').select(['version', 'freeze_state']).where('incident_id', '=', incident.id).executeTakeFirst())!
          assert.equal(scope.freeze_state, 'frozen'); assert.equal(incident.version, saved.expectedVersion + 1); assert.equal(scope.version, saved.expectedRetentionVersion + 1)
          publicWriteAttempted = false; Date.now = () => saved.rollbackNow
          await assert.rejects(() => command(incident.version as number, scope.version as number), status(409))
          assert.equal(publicWriteAttempted, false, 'Committed freeze refuses before any payload write despite fresh versions')
          assert.deepEqual(await payloadRows(), saved.rows); assert.deepEqual(namespace(), saved.namespace)
          console.log(`PASS actual concurrent ${kind} public writer reaches held C CAS and fresh committed freeze refuses under controlled clock rollback`)
        }
        finally { unhook(); Date.now = originalNow }
      }
      else if (mode === 'accept') {
        const wait = Date.parse(saved.expiresAt) - Date.now() + 20
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        assert(Date.now() > Date.parse(saved.expiresAt), 'C acceptance must be genuinely due without a clock override')
        const preview = await purge.previewPublicSafetyPurge(saved.key)
        assert.equal(preview.eligibility, 'eligible')
        let stopped = false
        const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
          const sql = event.sql.replace(/["`]/g, '').toLowerCase()
          if (stopped || !sql.startsWith('update public_safety_retention_scopes') || !event.params?.includes('frozen')) return
          stopped = true; writeFileSync(join(root, 'mixed-acceptor-paused'), 'actual-common-and-scope-write-CAS'); process.kill(process.pid, 'SIGSTOP')
        } })
        try {
          const accepted = await purge.acceptPublicSafetyPurge(saved.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
          assert(stopped); assert.equal(accepted.purge.state, 'building')
          assert.equal((await database.db.primary.selectFrom('public_safety_purge_events').select('id').execute()).length, 1)
          assert.deepEqual(await payloadRows(), saved.rows); assert.deepEqual(namespace(), saved.namespace)
          console.log('PASS actual genuinely due C acceptance COMMIT follows six refused overlapping native public writers')
        }
        finally { unhook() }
      }
      else if (mode === 'verify') {
        assert.deepEqual(await payloadRows(), saved.rows); assert.deepEqual(namespace(), saved.namespace)
        const preview = await purge.previewPublicSafetyPurge(saved.key)
        assert.equal(preview.inventoryKind, 'accepted-frozen'); assert(preview.existingPurgeKey)
        const current = await purge.readPublicSafetyPurge(saved.key, preview.existingPurgeKey)
        assert.equal(current.version, 1); assert.equal(current.state, 'building'); assert.equal(current.incidentVersion, saved.expectedVersion + 1); assert.equal(current.retentionVersion, saved.expectedRetentionVersion + 1)
        assert.equal(current.planned.sources, 2); assert.equal(current.planned.observations, 1); assert.equal(current.planned.reviews, 1); assert.equal(current.planned.managedArtifacts, 1)
        assert.equal((await database.db.primary.selectFrom('public_safety_purge_events').select('id').execute()).length, 1)
        console.log('PASS actual six-process mixed freeze matrix preserves payload namespace and one accepted authority')
      }
      else throw new Error('Unknown mixed freeze mode')
    })
  }
}
finally { await database.closeDatabaseConnection() }
