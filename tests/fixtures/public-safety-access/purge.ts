import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, root, retention, records, managed, access, status } from './managed-context'
import { purgeAbilities, purgeCoverage, purgeExclusions, purgePolicy } from '../../../resources/functions/drone/public-safety/purge/types'
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
import { inspectTemporaryWorkspace } from '../../../resources/functions/artifacts/native-storage/temporary-workspaces'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const positive = process.argv.includes('--require-positive')
const coordinator = await actor('purge-coordinator')
try {
  await as(coordinator.token.plainTextToken, async () => {
    const setup = await seed('purge-tracer', 20000)
    const member = await actor('purge-custodian')
    await access.changePublicSafetyMembership('purge-tracer', { expectedVersion: 3, userId: member.user.id, role: 'evidence-custodian' })
    const capture = setup.run.survey.captures[0]!, support = setup.run.captures[0]!.support.findIndex(value => value === 1)
    const observation = await records.appendPublicSafetyObservation('purge-tracer', { expectedVersion: 4, sourceDigest: setup.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private-purge-observation-fragment', uncertaintyNote: 'private-purge-uncertainty-fragment' })
    const first = await records.appendPublicSafetyReview('purge-tracer', observation.observation.id, { expectedVersion: 5, sourceDigest: setup.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'private-purge-review-fragment-one' })
    await records.appendPublicSafetyReview('purge-tracer', observation.observation.id, { expectedVersion: 6, sourceDigest: setup.source.digest, previousReviewId: first.review.id, disposition: 'supported-by-source', note: 'private-purge-review-fragment-two' })
    const created = await managed.createPublicSafetyManagedDataset('purge-tracer', { ...setup.body, expectedVersion: 7 })
    const tree = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key)
    const offline = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, 'offline-sentinel.txt'); writeFileSync(offline, 'excluded-offline-fragment', { mode: 0o600 })
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'false'
    let preview = await purge.previewPublicSafetyPurge('purge-tracer')
    assert.equal(preview.executorEnabled, false); assert.equal(preview.existingPurgeKey, null)
    await assert.rejects(() => job.dispatchNow(undefined), status(409))
    assert(existsSync(join(tree, 'manifest.json')))
    const disabledBody = { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() }
    await assert.rejects(() => purge.acceptPublicSafetyPurge('purge-tracer', disabledBody), status(409))
    const wait = Date.parse(setup.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    preview = await purge.previewPublicSafetyPurge('purge-tracer')
    assert.equal(preview.reason, 'eligible'); assert.equal(preview.inventoryKind, 'current-preview')
    const body = { ...disabledBody, inventoryDigest: preview.inventoryDigest }
    const accepted = await purge.acceptPublicSafetyPurge('purge-tracer', body)
    assert.equal(accepted.purge.state, 'building'); assert.equal(accepted.purge.contentDeletionPerformed, false)
    assert.equal((await purge.acceptPublicSafetyPurge('purge-tracer', Object.fromEntries(Object.entries({ ...body, exclusions: Object.fromEntries(Object.entries(body.exclusions).reverse()) }).reverse()))).replayed, true)
    assert.equal((await purge.previewPublicSafetyPurge('purge-tracer')).inventoryKind, 'accepted-frozen')
    assert.equal((await purge.previewPublicSafetyPurge('purge-tracer')).existingPurgeKey, accepted.purge.purgeKey)
    await assert.rejects(() => retention.readPublicSafetyRetention('purge-tracer'), status(409))
    if (positive) {
      assert.equal(process.platform, 'linux')
      assert.equal(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST, '1')
      const reader = Bun.spawn([process.execPath, '-e', "const fs=require('node:fs');fs.openSync(process.argv[1],'r');process.stdout.write('READY');setInterval(()=>{},1000)", join(tree, 'recording.json')], { cwd: tree, stdout: 'pipe', stderr: 'pipe' })
      try {
        const ready = await reader.stdout.getReader().read(); assert.equal(new TextDecoder().decode(ready.value), 'READY')
        const held = inspectTemporaryWorkspace(tree); assert.equal(held.unused, false); assert.equal(held.reason, 'process-reference')
        let blocked = accepted.purge
        for (let n = 0; n < 20 && blocked.state !== 'blocked'; n++) { await job.dispatchNow({ purgeKey: blocked.purgeKey }); blocked = await purge.readPublicSafetyPurge('purge-tracer', blocked.purgeKey) }
        assert.equal(blocked.state, 'blocked'); assert.equal(blocked.completed.namesUnlinked, 0); assert(existsSync(join(tree, 'manifest.json')))
      }
      finally { reader.kill('SIGTERM'); await reader.exited }
      let state = await purge.readPublicSafetyPurge('purge-tracer', accepted.purge.purgeKey)
      await purge.retryPublicSafetyPurge('purge-tracer', state.purgeKey, { expectedPurgeVersion: state.version, expectedRetentionVersion: state.retentionVersion, requestId: randomUUID() })
      const foreign = join(root, 'foreign-mount-sentinel'), target = join(tree, 'mounted-fixture')
      mkdirSync(foreign, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 }); writeFileSync(join(foreign, 'sentinel'), 'foreign-mount-fragment')
      const mounted = Bun.spawnSync(['mount', '--bind', foreign, target], { stdout: 'pipe', stderr: 'pipe' })
      assert.equal(mounted.exitCode, 0, mounted.stderr.toString())
      try {
        assert.equal(inspectTemporaryWorkspace(tree).reason, 'mounted')
        await job.dispatchNow({ purgeKey: state.purgeKey }); state = await purge.readPublicSafetyPurge('purge-tracer', state.purgeKey)
        assert.equal(state.state, 'blocked'); assert.equal(state.completed.namesUnlinked, 0)
        assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'foreign-mount-fragment')
      }
      finally { const unmounted = Bun.spawnSync(['umount', target], { stdout: 'pipe', stderr: 'pipe' }); assert.equal(unmounted.exitCode, 0, unmounted.stderr.toString()); rmdirSync(target) }
      await purge.retryPublicSafetyPurge('purge-tracer', state.purgeKey, { expectedPurgeVersion: state.version, expectedRetentionVersion: state.retentionVersion, requestId: randomUUID() })
      console.log('PASS actual namespace process reference and bind mount preserve accepted files before positive execution')
    }
    const inspected = inspectTemporaryWorkspace(tree)
    console.log(`Native actual process inspection: ${JSON.stringify(inspected)}`)
    let current = accepted.purge
    for (let index = 0; index < 80 && current.state !== 'complete'; index++) {
      await job.dispatchNow({ purgeKey: current.purgeKey })
      current = await purge.readPublicSafetyPurge('purge-tracer', current.purgeKey)
      if (current.state === 'blocked') { console.log('Blocked tracer status', JSON.stringify(current)); break }
    }
    assert.equal(current.dbState, 'complete')
    assert.equal(current.completed.sourceRowsRemoved, 1); assert.equal(current.completed.observationRowsRemoved, 1); assert.equal(current.completed.reviewRowsRemoved, 2)
    assert.equal(current.completed.incidentPayloadRowsCleared, 1)
    for (const table of ['public_safety_sources', 'public_safety_observations', 'public_safety_reviews']) assert.equal((await database.db.primary.selectFrom(table).select('id').execute()).length, 0)
    const tombstone = await database.db.primary.selectFrom('public_safety_incidents').select(['config_json', 'purpose', 'revision', 'status']).where('incident_key', '=', 'purge-tracer').executeTakeFirst()
    assert.deepEqual(tombstone, { config_json: null, purpose: null, revision: null, status: 'purged' })
    assert.equal(readFileSync(offline, 'utf8'), 'excluded-offline-fragment')
    if (positive) {
      assert.equal(process.platform, 'linux'); assert.equal(inspected.unused, true, 'Positive qualification requires real complete process visibility')
      assert.equal(current.state, 'complete', JSON.stringify(current))
      assert.equal(existsSync(tree), false)
      assert(current.completed.namesUnlinked > 0); assert.equal(current.completed.namesAbsenceReconciled, 0)
      assert.equal(current.completed.namesInitiallyAbsent, 1)
      assert.equal(current.completed.namesVerifiedAbsent, current.completed.namesUnlinked + 1)
      const custody = await retention.readPublicSafetyRetention('purge-tracer')
      assert('purged' in custody && custody.purged === true)
      assert.deepEqual(Object.keys(custody).sort(), ['capabilities', 'expired', 'historyRetired', 'incidentVersion', 'key', 'policyVersion', 'purgeKey', 'purged', 'retainUntil', 'version'].sort())
      const items = await database.db.primary.selectFrom('public_safety_purge_items').selectAll().execute(); assert.equal(items.length, 0)
      for (const table of ['public_safety_managed_artifacts', 'public_safety_managed_artifact_files', 'public_safety_managed_artifact_events', 'public_safety_retention_events']) assert.equal((await database.db.primary.selectFrom(table).select('id').execute()).length, 0)
      const serialized = JSON.stringify(await database.db.primary.selectFrom('public_safety_purges').selectAll().execute())
      for (const privateFragment of ['private-purge-observation', 'private-purge-review', tree, 'manifest.json']) assert(!serialized.includes(privateFragment))
      console.log('PASS actual native Job purge removes accepted files and private DB payload and retains minimized receipt')
    }
    else if (!inspected.unused) {
      assert.equal(current.state, 'blocked'); assert.equal(current.outcomeCode, 'inspection-unavailable')
      assert(existsSync(join(tree, 'manifest.json')))
      console.log('PASS actual native inspection refusal preserves namespace while accepted DB payload is removed')
    }
    else { assert.equal(current.state, 'complete', JSON.stringify(current)); console.log('PASS actual native local process visibility permits accepted purge') }
    assert.equal(current.diagnosticsErased, false); assert.equal(current.allCopiesErased, false); assert.equal(current.mediaErasure, false)
    const revoke = await retention.revokePublicSafetyCustodyMember('purge-tracer', { expectedRetentionVersion: current.retentionVersion, userId: member.user.id, requestId: randomUUID() })
    assert('purge' in revoke && revoke.event.actor.kind === 'human')
    await as(member.token.plainTextToken, async () => { await assert.rejects(() => purge.readPublicSafetyPurge('purge-tracer', current.purgeKey), status(403)) })
    assert.equal(readFileSync(offline, 'utf8'), 'excluded-offline-fragment')
    assert.deepEqual(readdirSync(process.env.PUBLIC_SAFETY_MANAGED_ROOT!).filter(name => name === 'offline-sentinel.txt'), ['offline-sentinel.txt'])
  })
}
finally { await database.closeDatabaseConnection() }
