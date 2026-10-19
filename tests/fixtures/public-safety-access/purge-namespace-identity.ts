import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chownSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed, root } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
function snapshot(directory: string) {
  return ['', ...readdirSync(directory, { recursive: true }).map(String).sort()].map(name => {
    const path = join(directory, name), stat = lstatSync(path, { bigint: true })
    return { name, dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), uid: String(stat.uid), gid: String(stat.gid), mode: String(stat.mode), nlink: String(stat.nlink), size: String(stat.size), bytes: stat.isFile() ? readFileSync(path).toString('base64') : null }
  })
}
const qualifyUid = process.platform === 'linux' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST === '1' && process.geteuid?.() === 0
if (qualifyUid) {
  assert.equal(process.ppid, 1, 'Privileged UID fixture must be a direct child of the isolated PID1 Bun runner')
  assert.equal(readlinkSync('/proc/self/ns/pid'), readlinkSync('/proc/1/ns/pid'))
  assert(/^NSpid:\s+1\s*$/m.test(readFileSync('/proc/1/status', 'utf8')))
}
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  const coordinator = await actor('purge-namespace-identity-coordinator')
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = [], kinds = ['root-replacement', 'parent-replacement', ...(qualifyUid ? ['root-uid', 'parent-uid'] : [])]
    for (const [index, kind] of kinds.entries()) {
      const key = `p-ni-${index}`, fixture = await seed(key, 15000), created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
      fixtures.push({ kind, key, expiresAt: fixture.config.retention.expiresAt, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) })
    }
    const wait = Math.max(...fixtures.map(value => Date.parse(value.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const [index, fixture] of fixtures.entries()) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key), accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      let current = accepted.purge
      for (let n = 0; n < 25 && current.state !== 'ready'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
      assert.equal(current.state, 'ready'); assert.equal(current.completed.namesUnlinked, 0)
      const target = fixture.kind.startsWith('root-') ? process.env.PUBLIC_SAFETY_MANAGED_ROOT! : fixture.directory
      const detached = join(root, `identity-detached-${index}`), sentinel = join(target, 'unknown-sentinel'), originalTarget = snapshot(target), originalBytes = readFileSync(join(fixture.directory, 'recording.json')), originalOwner = lstatSync(target)
      const replacement = fixture.kind.endsWith('replacement')
      let sentinelBefore: ReturnType<typeof snapshot> | undefined, driftedBefore: ReturnType<typeof snapshot> | undefined
      if (replacement) {
        // Actual rename/replacement after ready. The private accepted C plan is never changed or forged.
        renameSync(target, detached); mkdirSync(target, { mode: 0o700 }); writeFileSync(sentinel, `unknown-${fixture.kind}-fragment`, { mode: 0o600 }); sentinelBefore = snapshot(target)
      }
      else {
        assert(qualifyUid, 'Actual UID drift requires explicit privileged Linux namespace qualification')
        // Any EPERM here fails the requested privileged qualification; it is never reported as positive UID evidence.
        chownSync(target, 65534, originalOwner.gid); assert.equal(lstatSync(target).uid, 65534); driftedBefore = snapshot(target)
      }
      try {
        for (let n = 0; n < 30 && current.state !== 'blocked'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
        assert.equal(current.state, 'blocked'); assert.equal(current.fsState, 'blocked'); assert.equal(current.outcomeCode, 'identity-changed'); assert.equal(current.dbState, 'complete')
        assert.equal(current.completed.namesUnlinked, 0); assert.equal(current.completed.fileInodesVerifiedAbsent, 0); assert.equal(current.completed.sourceRowsRemoved, 1); assert.equal(current.completed.incidentPayloadRowsCleared, 1); assert.equal(current.completedAt, null)
        const purgeRow = (await database.db.primary.selectFrom('public_safety_purges').select('incident_id').where('purge_key', '=', current.purgeKey).executeTakeFirst())!
        assert.equal((await database.db.primary.selectFrom('public_safety_sources').select('id').where('incident_id', '=', purgeRow.incident_id).execute()).length, 0)
        const incident = (await database.db.primary.selectFrom('public_safety_incidents').select(['config_json', 'purpose', 'revision']).where('id', '=', purgeRow.incident_id).executeTakeFirst())!
        assert.equal(incident.config_json, null); assert.equal(incident.purpose, null); assert.equal(incident.revision, null)
        if (replacement) {
          assert.deepEqual(snapshot(detached), originalTarget); assert.deepEqual(snapshot(target), sentinelBefore)
          const originalDirectory = fixture.kind.startsWith('root-') ? join(detached, fixture.directory.slice(target.length + 1)) : detached
          assert.deepEqual(readFileSync(join(originalDirectory, 'recording.json')), originalBytes)
        }
        else { assert.deepEqual(snapshot(target), driftedBefore); assert.deepEqual(readFileSync(join(fixture.directory, 'recording.json')), originalBytes) }
        console.log(`PASS actual ${fixture.kind} preserves detached or UID-drifted owned bytes and unknown replacement while accepted DB arm completes`)
      }
      finally {
        // Restore only the exact disposable fixture mutation after the preservation assertions; production never repairs/adopts this namespace.
        if (replacement) { unlinkSync(sentinel); rmdirSync(target); renameSync(detached, target) }
        else chownSync(target, originalOwner.uid, originalOwner.gid)
      }
      assert.deepEqual(snapshot(target), originalTarget)
    }
    if (!qualifyUid) console.log('UNQUALIFIED UID drift requires explicit privileged Linux namespace; no local chown success is claimed')
  })
}
finally { await database.closeDatabaseConnection() }
