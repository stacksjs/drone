import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const { database, User } = await setupIncidentDatabase()
const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, revokeToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
const status = (code: number) => (error: unknown) => error instanceof retention.PublicSafetyAccessError && error.status === code
try {
  if (process.env.CUSTODY_DURABILITY_READ === '1') {
    const saved = JSON.parse(await readFile(join(process.cwd(), 'custody-durability.json'), 'utf8'))
    await as(saved.token, async () => {
      assert.deepEqual(await retention.readPublicSafetyRetention(saved.key), saved.scope)
      assert.deepEqual(await retention.listPublicSafetyRetentionEvents(saved.key, { afterSequence: saved.cursor }), saved.events)
      assert.deepEqual(await database.db.primary.selectFrom('public_safety_sources').select(['id', 'canonical_json']).execute(), saved.payload)
    })
    console.log('PASS custody history and untouched source payload survive a fresh process')
  }
  else {
    const coordinator = await User.create({ name: 'Retention Coordinator', email: 'retention-matrix@example.invalid', password: 'temporary-fixture-password' })
    for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
    const credential = await createToken(coordinator.id, 'retention matrix', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    await as(credential.plainTextToken, async () => {
      const config = examplePublicSafetyConfig()
      config.id = 'custody-matrix'
      config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
      await access.createPublicSafetyIncident({ config })
      const currentVersion = async () => (retainedPreview(await retention.previewPublicSafetyRetention(config.id))).incidentVersion
      const actors = new Map<string, { id: number, token: string }>()
      for (const role of ['pilot', 'observer', 'reviewer', 'evidence-custodian', 'outsider'] as const) {
        const actor = await User.create({ name: `Custody ${role}`, email: `custody-${role}@example.invalid`, password: 'temporary-fixture-password' })
        await Rbac.givePermission(actor.id, 'public-safety:access', 'web')
        if (role !== 'outsider') await access.changePublicSafetyMembership(config.id, { expectedVersion: await currentVersion(), userId: actor.id, role })
        actors.set(role, { id: actor.id, token: (await createToken(actor.id, role, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
      }
      const custodian = actors.get('evidence-custodian')!, pilot = actors.get('pilot')!, observer = actors.get('observer')!
      const run = simulatePublicSafety({ config, seconds: 10 })
      assert.equal(run.captures.length, 1)
      const source = await records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording: run })
      const capture = run.survey.captures[0]!, index = run.captures[0]!.support.findIndex(value => value === 1)
      const point = await records.appendPublicSafetyObservation(config.id, { expectedVersion: await currentVersion(), sourceDigest: source.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: index % capture.width, y: Math.floor(index / capture.width) }, note: 'PRIVATE-CUSTODY-ANNOTATION', uncertaintyNote: 'PRIVATE-CUSTODY-UNCERTAINTY' })
      let lastReview = (await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: await currentVersion(), sourceDigest: source.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'PRIVATE-CUSTODY-REVIEW' })).review.id
      const initialConfig = (await database.db.primary.selectFrom('public_safety_incidents').select(['config_json', 'id']).where('incident_key', '=', config.id).executeTakeFirst())!
      const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
      assert.deepEqual(preview.counts, { sources: 1, observations: 1, reviews: 1 })
      assert.equal(preview.originalHold, 'none')
      assert.equal(preview.inventoryDigest.length, 64)
      assert.equal(preview.legacyOfflineExportsManaged, false)
      assert.equal(preview.contentDeletionPerformed, false)
      const serialized = JSON.stringify(preview)
      for (const privateValue of [source.source.digest, 'PRIVATE-CUSTODY-', 'rgba', 'config', 'purposeAuthority', 'revision', 'geometry']) assert(!serialized.includes(privateValue))
      assert.deepEqual(await as(custodian.token, () => retention.previewPublicSafetyRetention(config.id)), preview)
      await assert.rejects(() => retention.readPublicSafetyRetention(config.id), status(404))
      const enrollmentBody = { expectedVersion: preview.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() }
      for (const role of ['pilot', 'observer', 'reviewer', 'outsider']) {
        const actor = actors.get(role)!
        await assert.rejects(() => as(actor.token, () => retention.previewPublicSafetyRetention(config.id)), status(403))
        await assert.rejects(() => as(actor.token, () => retention.enrollPublicSafetyRetention(config.id, enrollmentBody)), status(403))
      }
      const otherConfig = { ...config, id: 'custody-other' }
      await access.createPublicSafetyIncident({ config: otherConfig })
      const otherPreview = retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id))
      await assert.rejects(() => retention.enrollPublicSafetyRetention(otherConfig.id, { ...enrollmentBody, expectedVersion: otherPreview.incidentVersion }), status(409))
      await access.changePublicSafetyMembership(config.id, { expectedVersion: preview.incidentVersion, userId: pilot.id, role: 'pilot' })
      await assert.rejects(() => retention.enrollPublicSafetyRetention(config.id, enrollmentBody), status(409))
      const fresh = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
      assert.notEqual(fresh.inventoryDigest, preview.inventoryDigest)
      const enrollment = await retention.enrollPublicSafetyRetention(config.id, { ...enrollmentBody, expectedVersion: fresh.incidentVersion, inventoryDigest: fresh.inventoryDigest })
      assert.equal(enrollment.scope.holdState, 'none')
      assert.equal(enrollment.scope.reviewRequired, false)
      assert.equal(enrollment.scope.reviewOverdue, false)
      assert.equal(enrollment.scope.reviewerUserId, null)
      const enroll = { ...enrollmentBody, expectedVersion: fresh.incidentVersion, inventoryDigest: fresh.inventoryDigest }
      const current = async () => { const retained = await retention.readPublicSafetyRetention(config.id); assert(!('purged' in retained)); return retained }
      const holdBody = async (extra: Record<string, unknown> = {}) => ({ expectedRetentionVersion: (await current()).version, decision: 'retain', caseReference: 'case:matrix-1', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID(), ...extra })
      const snapshot = async () => ({ scope: await current(), events: await retention.listPublicSafetyRetentionEvents(config.id), members: await database.db.primary.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', initialConfig.id).orderBy('id', 'asc').execute() })
      for (const bad of [{ requestId: `${randomUUID()}\n` }, { requestId: randomUUID().toUpperCase() }, { policyVersion: 'later' }, { inventoryDigest: `${fresh.inventoryDigest}\n` }, { expectedVersion: '1' }, { actorUserId: coordinator.id }]) await assert.rejects(() => retention.enrollPublicSafetyRetention(config.id, { ...enroll, ...bad }), status(422))
      for (const bad of [{ caseReference: '' }, { caseReference: 'case description' }, { caseReference: 'é' }, { caseReference: 'x'.repeat(129) }, { caseReference: 'case\n' }, { reviewDueAt: new Date(Date.now() - 1000).toISOString() }, { reviewDueAt: new Date(Date.now() + 31 * 86400000).toISOString() }, { reviewDueAt: '2026-01-01T00:00:00Z' }, { reviewDueAt: null }, { decision: 'release', reviewDueAt: new Date().toISOString() }, { decision: 'grant-access' }, { expectedRetentionVersion: 0 }, { expectedRetentionVersion: '1' }, { actorUserId: coordinator.id }]) await assert.rejects(async () => retention.reviewPublicSafetyRetentionHold(config.id, await holdBody(bad)), status(422))
      let called = 0
      const getterBody = Object.defineProperty(await holdBody(), 'caseReference', { enumerable: true, get() { called++; return 'case' } })
      await assert.rejects(() => retention.reviewPublicSafetyRetentionHold(config.id, getterBody), status(422))
      assert.equal(called, 0)
      const firstHold = await holdBody({ caseReference: 'x'.repeat(128) })
      const held = await as(custodian.token, () => retention.reviewPublicSafetyRetentionHold(config.id, firstHold))
      assert.equal(held.event.actorUserId, custodian.id)
      assert.equal(held.scope.capabilities.canRevokeMembers, false)
      assert.equal(held.scope.capabilities.canManageHold, true)
      assert.equal(held.scope.holdState, 'held')
      const retry = await retention.reviewPublicSafetyRetentionHold(config.id, firstHold)
      assert.equal(retry.replayed, true)
      assert.deepEqual(retry.event, held.event)
      await assert.rejects(() => retention.reviewPublicSafetyRetentionHold(config.id, { ...firstHold, caseReference: 'case:different' }), status(409))
      await assert.rejects(async () => retention.reviewPublicSafetyRetentionHold(config.id, { ...await holdBody(), requestId: enroll.requestId }), status(409))
      await assert.rejects(() => retention.enrollPublicSafetyRetention(config.id, { ...enroll, requestId: held.event.requestId }), status(409))
      await assert.rejects(() => as(custodian.token, () => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: held.scope.version, userId: pilot.id, requestId: randomUUID() })), status(403))
      await assert.rejects(() => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: held.scope.version, userId: coordinator.id, requestId: randomUUID() }), status(409))
      const readOnly = (await createToken(coordinator.id, 'custody read only', ['public-safety:read'], { withRefreshToken: false })).plainTextToken
      const readOnlyStatus = await as(readOnly, () => retention.readPublicSafetyRetention(config.id))
      assert.deepEqual(readOnlyStatus.capabilities, { canManageHold: false, canRevokeMembers: false })
      const coordinateOnly = (await createToken(coordinator.id, 'custody coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
      const validHold = await holdBody()
      await assert.rejects(() => as(readOnly, () => retention.reviewPublicSafetyRetentionHold(config.id, validHold)), status(403))
      await assert.rejects(() => as(readOnly, () => retention.enrollPublicSafetyRetention(config.id, enroll)), status(403))
      await assert.rejects(() => as(readOnly, () => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: held.scope.version, userId: pilot.id, requestId: randomUUID() })), status(403))
      await assert.rejects(() => as(coordinateOnly, () => retention.readPublicSafetyRetention(config.id)), status(403))
      await as(coordinateOnly, () => retention.reviewPublicSafetyRetentionHold(config.id, validHold))
      for (const userId of [0, 1.5, '1', NaN, Infinity]) await assert.rejects(async () => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: (await current()).version, userId, requestId: randomUUID() }), status(422))
      await assert.rejects(() => retention.reviewPublicSafetyRetentionHold(config.id, { ...firstHold, requestId: randomUUID() }), status(409))
      const beforeRaces = await snapshot(), raceBody = await holdBody()
      const race = await Promise.allSettled([
        as(credential.plainTextToken, () => retention.reviewPublicSafetyRetentionHold(config.id, raceBody)),
        as(credential.plainTextToken, () => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: raceBody.expectedRetentionVersion, userId: observer.id, requestId: randomUUID() })),
      ])
      assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
      for (const result of race) if (result.status === 'rejected') assert(status(409)(result.reason))
      assert.equal((await current()).version, beforeRaces.scope.version + 1)
      assert.equal((await current()).incidentVersion, beforeRaces.scope.incidentVersion + 1)
      const sameBody = await holdBody(), beforeSame = await current()
      const same = await Promise.all([as(credential.plainTextToken, () => retention.reviewPublicSafetyRetentionHold(config.id, sameBody)), as(custodian.token, () => retention.reviewPublicSafetyRetentionHold(config.id, sameBody))])
      assert.equal(same.filter(result => result.replayed).length, 1)
      assert.equal(same[0]!.event.id, same[1]!.event.id)
      assert.equal((await current()).version, beforeSame.version + 1)
      const distinctVersion = (await current()).version
      const distinctBodies = await Promise.all([0, 1].map(i => holdBody({ expectedRetentionVersion: distinctVersion, caseReference: `case:contender-${i}` })))
      const distinct = await Promise.allSettled(distinctBodies.map(body => as(credential.plainTextToken, () => retention.reviewPublicSafetyRetentionHold(config.id, body))))
      assert.equal(distinct.filter(result => result.status === 'fulfilled').length, 1)
      for (const result of distinct) if (result.status === 'rejected') assert(status(409)(result.reason))
      assert.equal((await current()).version, distinctVersion + 1)
      for (const action of ['enrolled', 'hold-reviewed', 'member-revoked'] as const) {
        const before = await snapshot(), otherBefore = retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id))
        await database.db.unsafe(`CREATE TRIGGER reject_custody_event BEFORE INSERT ON public_safety_retention_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'custody event persistence fault'); END`)
        try {
          if (action === 'enrolled') await assert.rejects(() => retention.enrollPublicSafetyRetention(otherConfig.id, { expectedVersion: otherBefore.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: otherBefore.inventoryDigest, requestId: randomUUID() }), /custody event persistence fault/)
          if (action === 'hold-reviewed') await assert.rejects(async () => retention.reviewPublicSafetyRetentionHold(config.id, await holdBody()), /custody event persistence fault/)
          if (action === 'member-revoked') await assert.rejects(() => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: before.scope.version, userId: pilot.id, requestId: randomUUID() }), /custody event persistence fault/)
        }
        finally { await database.db.unsafe('DROP TRIGGER reject_custody_event') }
        assert.deepEqual(await snapshot(), before)
        assert.deepEqual(retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id)), otherBefore)
        await assert.rejects(() => retention.readPublicSafetyRetention(otherConfig.id), status(404))
      }
      for (const command of ['enroll', 'hold', 'revoke'] as const) {
        for (const change of ['token', 'permission', 'membership'] as const) {
          const before = await snapshot(), otherBefore = retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id))
          const lateToken = (await createToken(coordinator.id, 'late custody revocation', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
          const key = command === 'enroll' ? otherConfig.id : config.id
          const ability = command === 'revoke' ? 'revoke' : 'manage'
          let armed = true, successful = 0
          Gate.after(async (user, name, allowed, args) => {
            if (!armed || name !== `public-safety:retention-${ability}` || args[0] !== key) return
            assert.equal(allowed, true); assert.equal(user?.id, coordinator.id)
            armed = false; successful++
            if (change === 'token') await revokeToken(lateToken)
            if (change === 'permission') await Rbac.revokePermission(coordinator.id, 'public-safety:access', 'web')
            if (change === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('user_id', '=', coordinator.id).execute()
          })
          try {
            const body = await holdBody()
            const work = command === 'enroll'
              ? () => retention.enrollPublicSafetyRetention(key, { expectedVersion: otherBefore.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: otherBefore.inventoryDigest, requestId: randomUUID() })
              : command === 'hold'
                ? () => retention.reviewPublicSafetyRetentionHold(key, body)
                : () => retention.revokePublicSafetyCustodyMember(key, { expectedRetentionVersion: before.scope.version, userId: pilot.id, requestId: randomUUID() })
            await assert.rejects(() => as<unknown>(lateToken, work), status(change === 'token' ? 401 : 403))
            assert.equal(successful, 1)
          }
          finally {
            armed = false
            if (change === 'permission') await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
            if (change === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('user_id', '=', coordinator.id).execute()
          }
          assert.deepEqual(await snapshot(), before)
          assert.deepEqual(retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id)), otherBefore)
        }
      }
      const twoPreview = retainedPreview(await retention.previewPublicSafetyRetention(otherConfig.id))
      const enrollRace = await Promise.allSettled([0, 1].map(() => as(credential.plainTextToken, () => retention.enrollPublicSafetyRetention(otherConfig.id, { expectedVersion: twoPreview.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: twoPreview.inventoryDigest, requestId: randomUUID() }))))
      assert.equal(enrollRace.filter(result => result.status === 'fulfilled').length, 1)
      for (const result of enrollRace) if (result.status === 'rejected') assert(status(409)(result.reason))
      // Exercise both inventory paging and custody history paging through real accepted operations.
      for (let i = 0; i < 101; i++) {
        lastReview = (await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: await currentVersion(), sourceDigest: source.source.digest, previousReviewId: lastReview, disposition: 'unresolved', note: `Private retained review ${i}` })).review.id
        await retention.reviewPublicSafetyRetentionHold(config.id, await holdBody({ decision: 'release', caseReference: `case:history-${i}`, reviewDueAt: null }))
      }
      const afterHistory = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
      assert.deepEqual(afterHistory.counts, { sources: 1, observations: 1, reviews: 102 })
      assert.notEqual(afterHistory.inventoryDigest, fresh.inventoryDigest)
      let cursor = 0, more = true
      const events: Awaited<ReturnType<typeof retention.listPublicSafetyRetentionEvents>>['entries'] = []
      while (more) { const page = await retention.listPublicSafetyRetentionEvents(config.id, { afterSequence: cursor, limit: 17 }); events.push(...page.entries); cursor = page.cursor; more = page.hasMore }
      assert.equal(events.length, (await current()).version)
      assert.equal(new Set(events.map(row => row.id)).size, events.length)
      assert.equal(events.at(-1)?.sequence, cursor)
      assert(events.some((row, i) => i > 0 && row.incidentVersion - events[i - 1]!.incidentVersion > 1))
      for (const options of [{ limit: 101 }, { limit: null }, { afterSequence: -1 }, { afterSequence: '0' }, { afterSequence: 2147483648 }, { extra: 1 }]) await assert.rejects(() => retention.listPublicSafetyRetentionEvents(config.id, options as never), status(422))
      const noContent = JSON.stringify({ scope: await current(), events })
      for (const forbidden of [source.source.digest, 'PRIVATE-CUSTODY-', 'canonical', 'config_json', 'inventoryDigest', 'rgba', 'quaternion']) assert(!noContent.includes(forbidden))
      assert.equal((await database.db.primary.selectFrom('public_safety_incidents').select('config_json').where('id', '=', initialConfig.id).executeTakeFirst())!.config_json, initialConfig.config_json)
      const preserved = await database.db.primary.selectFrom('public_safety_sources').select(['id', 'canonical_json']).execute()
      const dueSoon = new Date(Date.now() + 2000).toISOString()
      const soonBody = await holdBody({ reviewDueAt: dueSoon })
      const heldAgain = await retention.reviewPublicSafetyRetentionHold(config.id, soonBody)
      assert.equal(heldAgain.scope.reviewOverdue, false)
      await access.closePublicSafetyIncident(config.id, { expectedVersion: await currentVersion() })
      const expiredConfig = { ...run.plan.config, retention: { ...run.plan.config.retention, expiresAt: new Date(Date.now() - 1).toISOString() } }
      await database.db.primary.updateTable('public_safety_incidents').set({ retain_until: expiredConfig.retention.expiresAt, config_json: publicSafetyRecordingData(expiredConfig) }).where('id', '=', initialConfig.id).execute()
      for (const read of [() => access.readPublicSafetyIncident(config.id), () => records.readPublicSafetySource(config.id, source.source.digest), () => records.listPublicSafetySources(config.id), () => records.readPublicSafetyObservation(config.id, point.observation.id), () => records.listPublicSafetyObservations(config.id), () => records.listPublicSafetyReviews(config.id, point.observation.id)]) await assert.rejects(read, status(404))
      const expired = await as(custodian.token, () => retention.readPublicSafetyRetention(config.id))
      assert(!('purged' in expired))
      assert.equal(expired.expired, true); assert.equal(expired.holdState, 'held'); assert.equal(expired.contentDeletionPerformed, false)
      await Bun.sleep(Math.max(0, Date.parse(dueSoon) - Date.now() + 10))
      const overdue = await current()
      assert.equal(overdue.reviewOverdue, true); assert.equal(overdue.holdState, 'held')
      assert.equal(overdue.version, heldAgain.scope.version)
      const soonRetry = await retention.reviewPublicSafetyRetentionHold(config.id, soonBody)
      assert.equal(soonRetry.replayed, true)
      assert.deepEqual(soonRetry.event, heldAgain.event)
      assert.equal(soonRetry.scope.version, overdue.version)
      const releasedExpired = await as(custodian.token, async () => retention.reviewPublicSafetyRetentionHold(config.id, await holdBody({ decision: 'release', reviewDueAt: null })))
      assert.equal(releasedExpired.scope.holdState, 'released'); assert.equal(releasedExpired.scope.expired, true)
      await assert.rejects(() => records.readPublicSafetySource(config.id, source.source.digest), status(404))
      await retention.reviewPublicSafetyRetentionHold(config.id, await holdBody())
      const revokeBody = { expectedRetentionVersion: (await current()).version, userId: pilot.id, requestId: randomUUID() }
      const revoked = await retention.revokePublicSafetyCustodyMember(config.id, revokeBody)
      assert('scope' in revoked)
      const revokedMember = await database.db.primary.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', initialConfig.id).where('user_id', '=', pilot.id).executeTakeFirst()
      assert.equal(Number(revokedMember!.active), 0)
      assert.equal((await retention.revokePublicSafetyCustodyMember(config.id, revokeBody)).replayed, true)
      assert.equal((await current()).version, revoked.scope.version)
      const beforeRemoval = await current(), removalBody = await holdBody()
      let armed = true, successful = 0
      Gate.after(async (user, name, allowed, args) => {
        if (!armed || name !== 'public-safety:retention-manage' || args[0] !== config.id || user?.id !== custodian.id) return
        assert.equal(allowed, true); armed = false; successful++
        await as(credential.plainTextToken, () => retention.revokePublicSafetyCustodyMember(config.id, { expectedRetentionVersion: beforeRemoval.version, userId: custodian.id, requestId: randomUUID() }))
      })
      try { await assert.rejects(() => as(custodian.token, () => retention.reviewPublicSafetyRetentionHold(config.id, removalBody)), status(403)) }
      finally { armed = false }
      assert.equal(successful, 1)
      assert.equal((await current()).version, beforeRemoval.version + 1)
      await assert.rejects(() => as(custodian.token, () => retention.readPublicSafetyRetention(config.id)), status(403))
      await assert.rejects(() => as(custodian.token, () => retention.enrollPublicSafetyRetention(config.id, enroll)), status(403))
      assert.deepEqual(await database.db.primary.selectFrom('public_safety_sources').select(['id', 'canonical_json']).execute(), preserved)
      assert.equal((await database.db.primary.selectFrom('public_safety_observations').select(['note', 'uncertainty_note']).where('id', '=', point.observation.id).executeTakeFirst())!.note, 'PRIVATE-CUSTODY-ANNOTATION')
      assert.equal((await database.db.primary.selectFrom('public_safety_incidents').select('config_json').where('id', '=', initialConfig.id).executeTakeFirst())!.config_json, publicSafetyRecordingData(expiredConfig))
      const pastConfig = { ...config, id: 'custody-past', retention: { ...config.retention, hold: 'declared-review-required' as const } }
      await access.createPublicSafetyIncident({ config: pastConfig })
      await access.changePublicSafetyMembership(pastConfig.id, { expectedVersion: 1, userId: custodian.id, role: 'evidence-custodian' })
      const pastExpired = { ...pastConfig, retention: { ...pastConfig.retention, expiresAt: new Date(Date.now() - 1).toISOString() } }
      await database.db.primary.updateTable('public_safety_incidents').set({ retain_until: pastExpired.retention.expiresAt, config_json: publicSafetyRecordingData(pastExpired) }).where('incident_key', '=', pastConfig.id).execute()
      const pastPreview = retainedPreview(await as(custodian.token, () => retention.previewPublicSafetyRetention(pastConfig.id)))
      assert.equal(pastPreview.expired, true)
      const pastEnrollment = await as(custodian.token, () => retention.enrollPublicSafetyRetention(pastConfig.id, { expectedVersion: pastPreview.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: pastPreview.inventoryDigest, requestId: randomUUID() }))
      assert.equal(pastEnrollment.scope.enrolledByUserId, custodian.id)
      assert.equal(pastEnrollment.event.actorUserId, custodian.id)
      assert.equal(pastEnrollment.scope.holdState, 'pending-review'); assert.equal(pastEnrollment.scope.reviewRequired, true)
      assert.equal(pastEnrollment.scope.reviewDueAt, null); assert.equal(pastEnrollment.scope.reviewerUserId, null)
      assert.equal(pastEnrollment.scope.expired, true); assert.equal(pastEnrollment.scope.purgeImplemented, false)
      await assert.rejects(() => access.readPublicSafetyIncident(pastConfig.id), status(404))
      const saved = { key: config.id, token: credential.plainTextToken, scope: await current(), cursor: cursor - 3, events: await retention.listPublicSafetyRetentionEvents(config.id, { afterSequence: cursor - 3 }), payload: preserved }
      await writeFile(join(process.cwd(), 'custody-durability.json'), JSON.stringify(saved), { mode: 0o600 })
      const child = Bun.spawn([process.execPath, `--config=${join(process.cwd(), 'bunfig.toml')}`, '--no-env-file', import.meta.path], { cwd: process.cwd(), env: { ...process.env, CUSTODY_DURABILITY_READ: '1' }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, `${stdout}\n${stderr}`)
      assert(stdout.includes('PASS custody history and untouched source payload survive a fresh process'))
    })
    console.log('PASS native custody inventory roles retries rollback races expiry revocation and durability')
  }
}
finally { await database.closeDatabaseConnection() }
