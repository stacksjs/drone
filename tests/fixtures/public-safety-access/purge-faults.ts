import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, root, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const cases = ['missing', 'replacement', 'extra', 'symlink', 'hardlink', 'permission', 'partial', 'pending-only', 'two-aliases'] as const
const coordinator = await actor('purge-fault-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures: { kind: typeof cases[number], key: string, expiresAt: string, directory: string, sentinel: string, initialRecordingBytes: number }[] = []
    for (const kind of cases) {
      const key = `purge-fault-${kind}`, fixture = await seed(key, 30000), created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
      const directory = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key), recording = join(directory, 'recording.json')
      const sentinel = join(root, `excluded-${kind}.txt`), initialRecordingBytes = readFileSync(recording).length
      writeFileSync(sentinel, `excluded-${kind}-fragment`, { mode: 0o600 })
      fixtures.push({ kind, key, expiresAt: fixture.config.retention.expiresAt, directory, sentinel, initialRecordingBytes })
    }
    const wait = Math.max(...fixtures.map(fixture => Date.parse(fixture.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key)
      const accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      const recording = join(fixture.directory, 'recording.json'), manifest = join(fixture.directory, 'manifest.json'), pending = join(fixture.directory, 'manifest.pending.json')
      if (fixture.kind === 'missing') unlinkSync(recording)
      if (fixture.kind === 'replacement') { const bytes = readFileSync(recording); renameSync(recording, `${fixture.sentinel}.original`); writeFileSync(recording, bytes, { mode: 0o600 }) }
      if (fixture.kind === 'extra') writeFileSync(join(fixture.directory, 'unknown.txt'), 'unknown-preserved-fragment', { mode: 0o600 })
      if (fixture.kind === 'symlink') { renameSync(recording, `${fixture.sentinel}.original`); symlinkSync(fixture.sentinel, recording) }
      if (fixture.kind === 'hardlink') linkSync(recording, `${fixture.sentinel}.hardlink`)
      if (fixture.kind === 'permission') chmodSync(recording, 0o644)
      if (fixture.kind === 'partial') truncateSync(recording, Math.floor(fixture.initialRecordingBytes / 2))
      if (fixture.kind === 'pending-only') renameSync(manifest, pending)
      if (fixture.kind === 'two-aliases') linkSync(manifest, pending)
      let current = accepted.purge
      for (let attempt = 0; attempt < 80 && current.state !== 'complete' && current.state !== 'blocked'; attempt++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
      assert.equal(current.dbState, 'complete', JSON.stringify(current))
      assert.equal(current.completed.sourceRowsRemoved, 1); assert.equal(current.completed.incidentPayloadRowsCleared, 1)
      assert.equal(readFileSync(fixture.sentinel, 'utf8'), `excluded-${fixture.kind}-fragment`)
      const successful = fixture.kind === 'partial' || fixture.kind === 'pending-only' || fixture.kind === 'two-aliases'
      if (successful && current.state === 'blocked' && current.outcomeCode === 'inspection-unavailable') { assert(existsSync(fixture.directory)); assert.notEqual(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST, '1', 'Qualified namespace positive visibility must not be bypassed'); console.log(`UNQUALIFIED positive local visibility ${fixture.kind}`); continue }
      if (successful) {
        assert.equal(current.state, 'complete', JSON.stringify(current)); assert.equal(existsSync(fixture.directory), false)
        assert.equal(current.completed.namesInitiallyAbsent, fixture.kind === 'two-aliases' ? 0 : 1)
        assert.equal(current.completed.namesAbsenceReconciled, 0)
        assert.equal(current.completed.namesVerifiedAbsent, current.completed.namesUnlinked + current.completed.namesInitiallyAbsent)
        if (fixture.kind === 'partial') assert(current.completed.observedFileBytes < current.planned.totalPlannedFileBytes)
      }
      else {
        assert.equal(current.state, 'blocked'); assert.equal(current.fsState, 'blocked'); assert(existsSync(fixture.directory))
        assert.equal(current.completed.namesUnlinked, 0)
        const outcome = { missing: 'missing-unarmed', replacement: 'identity-changed', extra: 'unexpected-entry', symlink: 'identity-changed', hardlink: 'unexpected-link', permission: 'identity-changed', partial: null, 'pending-only': null, 'two-aliases': null }[fixture.kind]
        assert.equal(current.outcomeCode, outcome)
        if (fixture.kind === 'replacement' || fixture.kind === 'symlink') assert(existsSync(`${fixture.sentinel}.original`))
        if (fixture.kind === 'hardlink') assert(existsSync(`${fixture.sentinel}.hardlink`))
      }
      console.log(`PASS actual controlled registered namespace ${fixture.kind}`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
