import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const { database, User } = await setupIncidentDatabase()
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, revokeToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
const as = <T>(token: string, action: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), action)
try {
  if (process.env.RECORD_DURABILITY_READ === '1') {
    const saved = JSON.parse(await readFile(join(process.cwd(), 'record-durability.json'), 'utf8'))
    await as(saved.token, async () => {
      const source = await records.readPublicSafetySource(saved.key, saved.digest)
      assert.equal(createHash('sha256').update(publicSafetyRecordingData(source.recording)).digest('hex'), saved.digest)
      assert.deepEqual(await records.readPublicSafetyObservation(saved.key, saved.observation.id), saved.observation)
      assert.deepEqual(await records.listPublicSafetyReviews(saved.key, saved.observation.id), saved.reviews)
      assert.deepEqual(await access.readPublicSafetyAudit(saved.key), saved.audit)
    })
    console.log('PASS source observation and review survive a fresh process')
  }
  else {
  const coordinator = await User.create({ name: 'Record Coordinator', email: 'record-coordinator@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
  const credential = await createToken(coordinator.id, 'record fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const config = examplePublicSafetyConfig()
  config.id = 'records-one'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const recording = simulatePublicSafety({ config, seconds: 16 })
  await as(credential.plainTextToken, async () => {
    await access.createPublicSafetyIncident({ config })
    const registered = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording })
    assert.equal(registered.incident.version, 2)
    assert.equal(registered.source.uploaderId, coordinator.id)
    assert.equal(registered.source.sourceIdentityAuthenticated, false)
    const read = await records.readPublicSafetySource(config.id, registered.source.digest)
    assert.equal(publicSafetyRecordingData(read.recording), publicSafetyRecordingData(recording))
    assert.equal((await records.listPublicSafetySources(config.id)).entries.length, 1)
    assert.equal((await access.readPublicSafetyAudit(config.id)).entries.at(-1)?.action, 'source-registered')
    const capture = recording.survey.captures[0]!, thermal = recording.captures[0]!
    const support = thermal.support.findIndex(value => value === 1)
    assert(support >= 0)
    const observationInput = { expectedVersion: 2, sourceDigest: registered.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Explicit source pixel declaration', uncertaintyNote: 'Synthetic source, physical meaning unqualified' }
    const appended = await records.appendPublicSafetyObservation(config.id, observationInput)
    assert.equal(appended.incident.version, 3)
    assert.deepEqual(appended.observation.pixel, observationInput.pixel)
    assert.equal(appended.observation.actorId, coordinator.id)
    assert.deepEqual(await records.readPublicSafetyObservation(config.id, appended.observation.id), appended.observation)
    const review = await records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: 3, sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Physical meaning remains unqualified' })
    assert.equal(review.incident.version, 4)
    assert.equal(review.review.selfReview, true)
    const latest = await records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: 4, sourceDigest: registered.source.digest, previousReviewId: review.review.id, disposition: 'supported-by-source', note: 'Source supports the pixel declaration, physical meaning remains unqualified' })
    assert.equal(latest.incident.version, 5)
    assert.deepEqual((await records.listPublicSafetyReviews(config.id, appended.observation.id)).entries.map(row => row.disposition), ['unresolved', 'supported-by-source'])
    assert.deepEqual(await records.readPublicSafetyObservation(config.id, appended.observation.id), appended.observation)
    assert.equal((await records.listPublicSafetyObservations(config.id)).entries.length, 1)
    const status = (code: number) => (error: unknown) => error instanceof access.PublicSafetyAccessError && error.status === code
    const currentVersion = async () => (await access.readPublicSafetyIncident(config.id)).version
    const appendObservation = async (overrides: Record<string, unknown> = {}) => records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: await currentVersion(), ...overrides })
    const appendReview = async (overrides: Record<string, unknown> = {}) => records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: await currentVersion(), sourceDigest: registered.source.digest, previousReviewId: (await records.listPublicSafetyReviews(config.id, appended.observation.id)).entries.at(-1)?.id ?? null, disposition: 'unresolved', note: 'Explicit review, synthetic meaning remains unqualified', ...overrides })
    const snapshot = async () => ({ incident: await access.readPublicSafetyIncident(config.id), audit: await access.readPublicSafetyAudit(config.id), sources: await records.listPublicSafetySources(config.id), observations: await records.listPublicSafetyObservations(config.id), reviews: await records.listPublicSafetyReviews(config.id, appended.observation.id) })
    // Worked fixture samples distinguish row-major source coordinates from a transposed lookup.
    assert.deepEqual([capture.width, capture.height, thermal.support[3840], thermal.support[40]], [96, 72, 1, 0])
    await appendObservation({ pixel: { x: 0, y: 40 } })
    await assert.rejects(() => appendObservation({ pixel: { x: 40, y: 0 } }), status(422))
    await assert.rejects(async () => records.readPublicSafetySource(`${config.id}\n`, registered.source.digest), status(422))
    await assert.rejects(async () => records.readPublicSafetySource(config.id, `${registered.source.digest}\n`), status(422))
    for (const invalid of [{ pixel: { x: -1, y: 0 } }, { pixel: { x: 0.5, y: 0 } }, { pixel: { x: '0', y: 0 } }, { pixel: { x: 0, y: NaN } }, { pixel: { x: 0, y: Infinity } }, { pixel: { x: capture.width, y: 0 } }, { pixel: { x: 0, y: capture.height } }, { pixel: { ...observationInput.pixel, actorId: coordinator.id } }, { modality: 'inferred' }, { captureId: `${capture.id}\n` }, { captureId: 'photo-9999' }, { note: ' ' }, { note: 'é'.repeat(1025) }, { uncertaintyNote: '🙂'.repeat(257) }, { actorId: coordinator.id }, { observedAt: '2026-01-01T00:00:00.000Z' }]) await assert.rejects(() => appendObservation(invalid), status(422))
    for (const unsupported of [0]) {
      const index = thermal.support.findIndex(value => value === unsupported)
      assert(index >= 0, `fixture must contain support ${unsupported}`)
      await assert.rejects(() => appendObservation({ pixel: { x: index % capture.width, y: Math.floor(index / capture.width) } }), status(422))
    }
    const thermalPoint = await appendObservation({ modality: 'thermal' })
    assert.equal(thermalPoint.observation.modality, 'thermal')
    assert.equal(thermalPoint.observation.sourceIdentityAuthenticated, false)
    await assert.rejects(() => appendReview({ previousReviewId: null }), status(409))
    await assert.rejects(() => appendReview({ previousReviewId: review.review.id }), status(409))
    await assert.rejects(() => appendReview({ actorId: coordinator.id }), status(422))
    await assert.rejects(() => appendReview({ disposition: 'confirmed-physical' }), status(422))
    const otherReview = await records.appendPublicSafetyReview(config.id, thermalPoint.observation.id, { expectedVersion: await currentVersion(), sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'not-supported-by-source', note: 'An independent declaration for a different observation' })
    await assert.rejects(() => appendReview({ previousReviewId: otherReview.review.id }), status(404))

    const otherConfig = { ...config, id: 'records-two' }
    await access.createPublicSafetyIncident({ config: otherConfig })
    const otherRun = simulatePublicSafety({ config: otherConfig, seconds: 16 })
    const otherSource = await records.registerPublicSafetySource(otherConfig.id, { expectedVersion: 1, recording: otherRun })
    assert.equal(otherRun.survey.captures[0]?.id, capture.id, 'capture IDs are reused across independent incident sources')
    const otherPoint = await records.appendPublicSafetyObservation(otherConfig.id, { ...observationInput, expectedVersion: 2, sourceDigest: otherSource.source.digest })
    await assert.rejects(async () => records.readPublicSafetySource(otherConfig.id, registered.source.digest), status(404))
    await assert.rejects(async () => records.appendPublicSafetyObservation(otherConfig.id, { ...observationInput, expectedVersion: 3 }), status(404))
    await assert.rejects(async () => records.readPublicSafetyObservation(config.id, otherPoint.observation.id), status(404))
    await assert.rejects(async () => records.appendPublicSafetyReview(config.id, otherPoint.observation.id, { expectedVersion: await currentVersion(), sourceDigest: otherSource.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Cross incident substitution refused' }), status(404))
    await assert.rejects(async () => records.listPublicSafetyReviews(config.id, otherPoint.observation.id), status(404))
    await assert.rejects(() => appendReview({ sourceDigest: otherSource.source.digest }), status(404))
    assert((await records.listPublicSafetyObservations(config.id)).entries.every(row => row.sourceDigest !== otherSource.source.digest))
    const maskedConfig = { ...config, id: 'records-masked', noObserveZones: [structuredClone(config.survey.boundary)] }
    await access.createPublicSafetyIncident({ config: maskedConfig })
    const maskedRun = simulatePublicSafety({ config: maskedConfig, seconds: 16 })
    const maskedSource = await records.registerPublicSafetySource(maskedConfig.id, { expectedVersion: 1, recording: maskedRun })
    const maskedIndex = maskedRun.captures[0]!.support.findIndex(value => value === 2)
    assert(maskedIndex >= 0)
    await assert.rejects(async () => records.appendPublicSafetyObservation(maskedConfig.id, { ...observationInput, expectedVersion: 2, sourceDigest: maskedSource.source.digest, pixel: { x: maskedIndex % capture.width, y: Math.floor(maskedIndex / capture.width) } }), status(422))


    const unchanged = await snapshot()
    for (const change of [{ policyId: 'other-declared-policy' }, { visitId: 'visit-2' }, { purpose: 'fire-observation' }, { retention: { ...config.retention, expiresAt: new Date(Date.now() + 2 * 86400000).toISOString() } }]) {
      const different = simulatePublicSafety({ config: { ...config, ...change }, seconds: 16 })
      await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording: different }), status(422))
    }
    for (const mutate of [
      (run: typeof recording) => { run.captures[0]!.thermalCentiKelvin[0] = 1 },
      (run: typeof recording) => { run.events[0]!.sequence++ },
      (run: typeof recording) => { Object.assign(run, { identityAuthenticated: true }) },
    ]) {
      const tampered = structuredClone(recording)
      mutate(tampered)
      await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording: tampered }), status(422))
    }
    let conversions = 0
    const hostile = Object.defineProperty({}, 'version', { enumerable: true, get() { conversions++; return 1 } })
    await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording: hostile }), status(422))
    assert.equal(conversions, 0)
    assert.deepEqual(await snapshot(), unchanged)
    await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording }), status(409))
    for (const scenario of ['link-loss', 'manual'] as const) {
      const partial = simulatePublicSafety({ config, scenario, seconds: scenario === 'manual' ? 8 : 16 })
      assert.notEqual(partial.survey.status, 'completed')
      if (scenario === 'manual') assert.equal(partial.survey.captures.length, 0)
      const accepted = await records.registerPublicSafetySource(config.id, { expectedVersion: await currentVersion(), recording: partial })
      const readPartial = await records.readPublicSafetySource(config.id, accepted.source.digest)
      assert.equal(publicSafetyRecordingData(readPartial.recording), publicSafetyRecordingData(partial))
      if (scenario === 'manual') await assert.rejects(() => appendObservation({ sourceDigest: accepted.source.digest }), status(422))
    }
    const sourcePage = await records.listPublicSafetySources(config.id, { limit: 1 })
    assert.equal(sourcePage.entries[0]?.digest, registered.source.digest)
    assert.equal(sourcePage.hasMore, true)
    assert.equal(JSON.stringify(sourcePage).includes('rgba'), false)
    let sourceCursor = 0, sourceCount = 0, sourceMore = true
    while (sourceMore) { const next = await records.listPublicSafetySources(config.id, { afterSequence: sourceCursor, limit: 1 }); sourceCount += next.entries.length; sourceCursor = next.cursor; sourceMore = next.hasMore }
    assert.equal(sourceCount, 3)

    const roles = ['coordinator', 'pilot', 'observer', 'reviewer', 'evidence-custodian'] as const
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i]!
      const actor = role === 'coordinator' ? coordinator : await User.create({ name: `Record ${role}`, email: `record-${role}@example.invalid`, password: 'temporary-fixture-password' })
      if (role !== 'coordinator') {
        await Rbac.givePermission(actor.id, 'public-safety:access', 'web')
        await access.changePublicSafetyMembership(config.id, { expectedVersion: await currentVersion(), userId: actor.id, role })
      }
      const actorToken = await createToken(actor.id, `record ${role}`, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
      const nextRun = simulatePublicSafety({ config, seconds: 17 + i })
      const sourceVersion = await currentVersion()
      await as(actorToken.plainTextToken, async () => {
        const submit = async () => records.registerPublicSafetySource(config.id, { expectedVersion: sourceVersion, recording: nextRun })
        if (['coordinator', 'pilot', 'evidence-custodian'].includes(role)) assert.equal((await submit()).source.uploaderId, actor.id)
        else await assert.rejects(submit, status(403))
        const ownPoint = await records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: (await access.readPublicSafetyIncident(config.id)).version })
        assert.equal(ownPoint.observation.actorId, actor.id)
        const currentReviews = await records.listPublicSafetyReviews(config.id, ownPoint.observation.id)
        assert.equal(currentReviews.entries.length, 0)
        const reviewInput = { expectedVersion: (await access.readPublicSafetyIncident(config.id)).version, sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Declared source review, no physical qualification' }
        if (role === 'coordinator' || role === 'reviewer') assert.equal((await records.appendPublicSafetyReview(config.id, ownPoint.observation.id, reviewInput)).review.selfReview, true)
        else await assert.rejects(async () => records.appendPublicSafetyReview(config.id, ownPoint.observation.id, reviewInput), status(403))
      })
    }
    const readOnly = await createToken(coordinator.id, 'read only', ['public-safety:read'], { withRefreshToken: false })
    const coordinateOnly = await createToken(coordinator.id, 'coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })
    const version = await currentVersion()
    for (const action of [async () => records.registerPublicSafetySource(config.id, { expectedVersion: version, recording }), async () => records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: version }), async () => records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: version, sourceDigest: registered.source.digest, previousReviewId: latest.review.id, disposition: 'unresolved', note: 'Read scope cannot append' })]) await assert.rejects(() => as<unknown>(readOnly.plainTextToken, action), status(403))
    await assert.rejects(() => as(coordinateOnly.plainTextToken, async () => records.readPublicSafetySource(config.id, registered.source.digest)), status(403))
    await as(coordinateOnly.plainTextToken, async () => records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: version }))

    for (const action of ['source-registered', 'observation-created', 'review-appended'] as const) {
      const before = await snapshot()
      await database.db.unsafe(`CREATE TRIGGER reject_record_audit BEFORE INSERT ON public_safety_audits WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'record audit persistence fault'); END`)
      try {
        if (action === 'source-registered') await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: before.incident.version, recording: simulatePublicSafety({ config, seconds: 23 }) }), /record audit persistence fault/)
        if (action === 'observation-created') await assert.rejects(() => appendObservation(), /record audit persistence fault/)
        if (action === 'review-appended') await assert.rejects(() => appendReview(), /record audit persistence fault/)
      }
      finally { await database.db.unsafe('DROP TRIGGER reject_record_audit') }
      assert.deepEqual(await snapshot(), before)
    }
    const concurrentVersion = await currentVersion()
    const races = await Promise.allSettled([
      records.registerPublicSafetySource(config.id, { expectedVersion: concurrentVersion, recording: simulatePublicSafety({ config, seconds: 24 }) }),
      appendObservation({ expectedVersion: concurrentVersion }),
      appendReview({ expectedVersion: concurrentVersion }),
    ])
    assert.equal(races.filter(row => row.status === 'fulfilled').length, 1)
    for (const result of races) if (result.status === 'rejected') assert(status(409)(result.reason))
    assert.equal(await currentVersion(), concurrentVersion + 1)
    assert.equal((await access.readPublicSafetyAudit(config.id)).entries.at(-1)?.sequence, concurrentVersion + 1)

    const currentIncident = await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', config.id).executeTakeFirst()
    assert(currentIncident)
    for (const ability of ['source-register', 'observation-create', 'review-append'] as const) {
      for (const state of ['token', 'permission', 'membership'] as const) {
        const before = await snapshot(), token = await createToken(coordinator.id, 'late revoked', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
        let armed = true, successful = 0
        Gate.after(async (user, name, allowed, args) => {
          if (!armed || name !== `public-safety:${ability}` || args[0] !== config.id) return
          assert.equal(allowed, true)
          assert.equal(user?.id, coordinator.id)
          armed = false; successful++
          if (state === 'token') await revokeToken(token.plainTextToken)
          if (state === 'permission') await Rbac.revokePermission(coordinator.id, 'public-safety:access', 'web')
          if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('incident_id', '=', currentIncident.id).where('user_id', '=', coordinator.id).execute()
        })
        try {
          const work = ability === 'source-register'
            ? async () => records.registerPublicSafetySource(config.id, { expectedVersion: before.incident.version, recording: simulatePublicSafety({ config, seconds: 25 }) })
            : ability === 'observation-create'
              ? async () => records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: before.incident.version })
              : async () => records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: before.incident.version, sourceDigest: registered.source.digest, previousReviewId: before.reviews.entries.at(-1)?.id ?? null, disposition: 'unresolved', note: 'Late authorization is required' })
          await assert.rejects(() => as<unknown>(token.plainTextToken, work), status(state === 'token' ? 401 : 403))
          assert.equal(successful, 1)
        }
        finally {
          armed = false
          if (state === 'permission') await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
          if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('incident_id', '=', currentIncident.id).where('user_id', '=', coordinator.id).execute()
        }
        assert.deepEqual(await snapshot(), before)
      }
    }

    const beforeMetadataDrift = await snapshot()
    await database.db.primary.updateTable('public_safety_incidents').set({ revision: 'inconsistent-revision' }).where('id', '=', currentIncident.id).execute()
    try {
      for (const read of [() => records.readPublicSafetySource(config.id, registered.source.digest), () => records.listPublicSafetySources(config.id), () => records.readPublicSafetyObservation(config.id, appended.observation.id), () => records.listPublicSafetyObservations(config.id), () => records.listPublicSafetyReviews(config.id, appended.observation.id)]) await assert.rejects(read, status(409))
    }
    finally { await database.db.primary.updateTable('public_safety_incidents').set({ revision: config.revision }).where('id', '=', currentIncident.id).execute() }
    assert.deepEqual(await snapshot(), beforeMetadataDrift)
    for (const options of [{ limit: null }, { limit: 101 }, { afterSequence: -1 }, { afterSequence: 2147483648 }, { afterSequence: '0' }, { extra: 1 }]) {
      await assert.rejects(async () => records.listPublicSafetySources(config.id, options as never), status(422))
      await assert.rejects(async () => records.listPublicSafetyObservations(config.id, options as never), status(422))
      await assert.rejects(async () => records.listPublicSafetyReviews(config.id, appended.observation.id, options as never), status(422))
    }
    const raceWinner = races.find(result => result.status === 'fulfilled')
    assert(raceWinner?.status === 'fulfilled')
    const observationIds: number[] = []
    let observationCursor = 0, observationMore = true
    while (observationMore) {
      const next = await records.listPublicSafetyObservations(config.id, { afterSequence: observationCursor, limit: 1 })
      observationIds.push(...next.entries.map(row => row.id)); observationCursor = next.cursor; observationMore = next.hasMore
    }
    assert.equal(observationIds.length, 9 + ('observation' in raceWinner.value ? 1 : 0))
    assert.equal(new Set(observationIds).size, observationIds.length)
    assert(!observationIds.includes(otherPoint.observation.id))
    const reviewIds: number[] = []
    let reviewCursor = 0, reviewMore = true
    while (reviewMore) {
      const next = await records.listPublicSafetyReviews(config.id, appended.observation.id, { afterSequence: reviewCursor, limit: 1 })
      reviewIds.push(...next.entries.map(row => row.id)); reviewCursor = next.cursor; reviewMore = next.hasMore
    }
    assert.equal(reviewIds.length, 2 + ('review' in raceWinner.value ? 1 : 0))
    assert.equal(new Set(reviewIds).size, reviewIds.length)
    assert(!reviewIds.includes(otherReview.review.id))

    const saved = { token: credential.plainTextToken, key: config.id, digest: registered.source.digest, observation: appended.observation, reviews: await records.listPublicSafetyReviews(config.id, appended.observation.id), audit: await access.readPublicSafetyAudit(config.id) }
    await writeFile(join(process.cwd(), 'record-durability.json'), JSON.stringify(saved), { mode: 0o600 })
    const child = Bun.spawn([process.execPath, `--config=${join(process.cwd(), 'bunfig.toml')}`, '--no-env-file', import.meta.path], { cwd: process.cwd(), env: { ...process.env, RECORD_DURABILITY_READ: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`)
    assert(stdout.includes('PASS source observation and review survive a fresh process'))
    const beforeClose = await currentVersion()
    await access.closePublicSafetyIncident(config.id, { expectedVersion: beforeClose })
    assert.equal((await records.listPublicSafetySources(config.id)).entries.length > 0, true)
    await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: beforeClose + 1, recording }), status(409))
    await assert.rejects(() => appendObservation(), status(409))
    await assert.rejects(() => appendReview(), status(409))
    await database.db.primary.updateTable('public_safety_incidents').set({ retain_until: new Date(Date.now()).toISOString() }).where('id', '=', currentIncident.id).execute()
    for (const read of [async () => records.readPublicSafetySource(config.id, registered.source.digest), async () => records.listPublicSafetySources(config.id), async () => records.readPublicSafetyObservation(config.id, appended.observation.id), async () => records.listPublicSafetyObservations(config.id), async () => records.listPublicSafetyReviews(config.id, appended.observation.id)]) await assert.rejects(read, status(404))
    for (const append of [() => records.registerPublicSafetySource(config.id, { expectedVersion: beforeClose + 1, recording }), () => records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion: beforeClose + 1 }), () => records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: beforeClose + 1, sourceDigest: registered.source.digest, previousReviewId: saved.reviews.entries.at(-1)?.id ?? null, disposition: 'unresolved', note: 'Expired scope cannot append' })]) await assert.rejects(append, status(404))

  })
  console.log('PASS native persisted source, explicit observation and append-only review lifecycle')
  }
}
finally { await database.closeDatabaseConnection() }
