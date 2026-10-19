import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
const { database, User } = await setupIncidentDatabase()
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
const status = (code: number) => (error: unknown) => error instanceof access.PublicSafetyAccessError && error.status === code
try {
  const user = await User.create({ name: 'Critical Records Coordinator', email: 'critical-records@example.invalid', password: 'temporary-fixture-password' })
  const member = await User.create({ name: 'Contending Member', email: 'contending-records@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(user.id, permission, 'web') }
  const token = (await createToken(user.id, 'critical records', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  await as(token, async () => {
    const config = examplePublicSafetyConfig()
    config.id = 'critical-records'
    config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    await access.createPublicSafetyIncident({ config })
    const run = simulatePublicSafety({ config, seconds: 16 })
    const source = (await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: run })).source
    const capture = run.survey.captures[0]!, pixel = { x: 0, y: capture.height - 1 }
    assert.equal(run.captures[0]!.support[pixel.y * capture.width + pixel.x], 1, 'literal bottom-left corner is actually observed')
    const input = { sourceDigest: source.digest, captureId: capture.id, modality: 'visible', pixel, note: 'Observed source corner', uncertaintyNote: 'é'.repeat(512) }
    const point = (await records.appendPublicSafetyObservation(config.id, { expectedVersion: 2, ...input })).observation
    assert.equal(new TextEncoder().encode(point.uncertaintyNote).length, 1024)
    assert.equal(point.uncertaintyNote, input.uncertaintyNote)
    const history = await records.appendPublicSafetyReview(config.id, point.id, { expectedVersion: 3, sourceDigest: source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Initial source declaration' })
    assert.equal(history.review.uncertaintyNote, input.uncertaintyNote)
    const incidentId = (writer.query('SELECT id FROM public_safety_incidents WHERE incident_key = ?').get(config.id) as { id: number }).id
    const otherConfig = { ...config, id: 'critical-other' }
    await access.createPublicSafetyIncident({ config: otherConfig })
    const foreignIncidentId = (writer.query('SELECT id FROM public_safety_incidents WHERE incident_key = ?').get(otherConfig.id) as { id: number }).id
    const foreign = await records.registerPublicSafetySource(otherConfig.id, { expectedVersion: 1, recording: simulatePublicSafety({ config: otherConfig, seconds: 16 }) })
    const foreignPoint = await records.appendPublicSafetyObservation(otherConfig.id, { expectedVersion: 2, ...input, sourceDigest: foreign.source.digest })
    const foreignReview = await records.appendPublicSafetyReview(otherConfig.id, foreignPoint.observation.id, { expectedVersion: 3, sourceDigest: foreign.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Foreign incident history' })
    const version = async () => (await access.readPublicSafetyIncident(config.id)).version
    const reviewInput = async () => ({ expectedVersion: await version(), sourceDigest: source.digest, previousReviewId: (await records.listPublicSafetyReviews(config.id, point.id)).entries.at(-1)?.id ?? null, disposition: 'unresolved', note: 'Source review contender' })
    const snapshot = async () => {
      const observations = await records.listPublicSafetyObservations(config.id)
      return { incident: await access.readPublicSafetyIncident(config.id), audit: await access.readPublicSafetyAudit(config.id), sources: await records.listPublicSafetySources(config.id), observations, reviews: await Promise.all(observations.entries.map(row => records.listPublicSafetyReviews(config.id, row.id))) }
    }
    const beforeAdversarial = await snapshot()
    const upperLeft = run.survey.captures[4]!, upperThermal = run.captures[4]!
    assert.equal(upperThermal.support[0], 1, 'later source capture actually observes the top-left corner')
    const upperPoint = await records.appendPublicSafetyObservation(config.id, { expectedVersion: await version(), ...input, captureId: upperLeft.id, pixel: { x: 0, y: 0 }, modality: 'thermal' })
    assert.deepEqual(upperPoint.observation.pixel, { x: 0, y: 0 })
    assert.deepEqual(Array.from(capture.rgba.slice(0, 4)), [0, 0, 0, 255], 'unobserved black is opaque, not valid observed imagery')
    await assert.rejects(async () => records.appendPublicSafetyObservation(config.id, { expectedVersion: await version(), ...input, pixel: { x: 0, y: 0 } }), status(422))
    // In this pinned producer every support1 sample has nonzero synthetic temperature and a
    // nonblack RGB scene. Such valid sources cannot exercise an observed-black/zero-thermal branch.
    for (let i = 0; i < upperThermal.support.length; i++) if (upperThermal.support[i] === 1) {
      assert(upperThermal.thermalCentiKelvin[i]! > 0)
      assert(upperLeft.rgba[i * 4] || upperLeft.rgba[i * 4 + 1] || upperLeft.rgba[i * 4 + 2])
    }
    let invoked = 0
    for (const pixelValue of [Object.defineProperty({ y: 0 }, 'x', { enumerable: true, get() { invoked++; return 0 } }), { x() { invoked++; return 0 }, y: 0 }]) await assert.rejects(async () => records.appendPublicSafetyObservation(config.id, { expectedVersion: await version(), ...input, pixel: pixelValue }), status(422))
    assert.equal(invoked, 0)
    const wrongAck = simulatePublicSafety({ config, scenario: 'wrong-ack', seconds: 16 })
    assert.equal(wrongAck.unmatchedAcks[0]?.sequence, 4)
    assert(!wrongAck.survey.captures.some(row => row.id === 'photo-0004'))
    const wrongSource = await records.registerPublicSafetySource(config.id, { expectedVersion: await version(), recording: wrongAck })
    await assert.rejects(async () => records.appendPublicSafetyObservation(config.id, { expectedVersion: await version(), ...input, sourceDigest: wrongSource.source.digest, captureId: 'photo-0004' }), status(422))
    const beforeTamper = await snapshot()
    for (const mutate of [
      (value: typeof run) => { value.survey.captures[0]!.pose.positionM[0] += .01 },
      (value: typeof run) => { value.survey.captures[0]!.capturedAtMs++ },
      (value: typeof run) => { value.captures[0]!.support[0] = 1 },
      (value: typeof run) => { value.captures[0]!.thermalCentiKelvin[pixel.y * capture.width + pixel.x] = 0 },
      (value: typeof run) => { Object.assign(value, { physicalFlightEnabled: true }) },
      (value: typeof run) => { Object.assign(value, { physicalThermalVerified: true }) },
      (value: typeof run) => { Object.assign(value, { replayProfile: 'other-owned-profile' }) },
    ]) {
      const changed = structuredClone(run)
      mutate(changed)
      await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await version(), recording: changed }), status(422))
    }
    const geometry = structuredClone(config)
    geometry.operatingBoundary = [[-4, -4], [4, -4], [4, 4], [-4, 4]]
    const geometryRun = simulatePublicSafety({ config: geometry, seconds: 16 })
    assert.equal(geometryRun.plan.config.id, config.id)
    assert.equal(geometryRun.plan.config.revision, config.revision)
    await assert.rejects(async () => records.registerPublicSafetySource(config.id, { expectedVersion: await version(), recording: geometryRun }), status(422))
    assert.deepEqual(await snapshot(), beforeTamper)
    assert.equal(beforeAdversarial.observations.entries.length + 1, beforeTamper.observations.entries.length)
    const rawSnapshot = () => ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_audits'].map(table => writer.query(`SELECT * FROM ${table} ORDER BY id`).all())
    // This is native query instrumentation, not a query replacement. A separate real SQLite
    // connection changes persisted state after the staged SELECT completed, before final TX.
    for (const kind of ['observation', 'review'] as const) {
      for (const change of ['close', 'expiry', 'incident-config', 'source-content', 'source-metadata', 'source-rebind', ...(kind === 'review' ? ['observation-metadata', 'observation-rebind'] : [])]) {
        const before = await snapshot(), body = await reviewInput(), beforeRows = rawSnapshot()
        const sourceRow = writer.query('SELECT * FROM public_safety_sources WHERE id = ?').get(source.id) as Record<string, string | number>
        const observationRow = writer.query('SELECT * FROM public_safety_observations WHERE id = ?').get(point.id) as Record<string, string | number>
        let fired = 0, sawObservation = false, hookError: unknown, interleaved: ReturnType<typeof rawSnapshot> | undefined
        const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
          const sql = event.sql.replace(/["`]/g, '').toLowerCase()
          if (!sql.startsWith('select')) return
          if (sql.includes('from public_safety_observations') && sql.includes('source_digest')) sawObservation = true
          if (fired || !sql.includes('from public_safety_sources') || !sql.includes('canonical_json')) return
          fired++
          try {
            assert.equal(event.rowCount, 1)
            if (kind === 'review') assert(sawObservation, 'the observation must already have been staged')
            if (change === 'close') writer.query("UPDATE public_safety_incidents SET status = 'closed' WHERE id = ?").run(incidentId)
            if (change === 'expiry') writer.query('UPDATE public_safety_incidents SET retain_until = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), incidentId)
            if (change === 'incident-config') writer.query('UPDATE public_safety_incidents SET config_json = ? WHERE id = ?').run(publicSafetyRecordingData(geometryRun.plan.config), incidentId)
            if (change === 'source-content') writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run('{}', source.id)
            if (change === 'source-metadata') writer.query('UPDATE public_safety_sources SET uploaded_at_iso = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', source.id)
            if (change === 'source-rebind') writer.query('UPDATE public_safety_sources SET incident_id = ? WHERE id = ?').run(foreignIncidentId, source.id)
            if (change === 'observation-metadata') writer.query('UPDATE public_safety_observations SET note = ? WHERE id = ?').run('Changed after staged read', point.id)
            if (change === 'observation-rebind') writer.query('UPDATE public_safety_observations SET source_id = ? WHERE id = ?').run(foreign.source.id, point.id)
            interleaved = rawSnapshot()
          }
          catch (error) { hookError = error }
        } })
        try {
          const action = kind === 'observation'
            ? () => records.appendPublicSafetyObservation(config.id, { expectedVersion: before.incident.version, ...input })
            : () => records.appendPublicSafetyReview(config.id, point.id, body)
          await assert.rejects(action, status(change === 'expiry' || change.endsWith('rebind') ? 404 : 409), `${kind}: ${change}`)
          if (hookError) throw hookError
          assert.equal(fired, 1)
          assert(interleaved)
          assert.deepEqual(rawSnapshot(), interleaved, 'only the external change persists, no append/version/audit side effect')
        }
        finally {
          unhook()
          writer.query('UPDATE public_safety_incidents SET status = ?, retain_until = ?, config_json = ? WHERE id = ?').run(before.incident.status, before.incident.retainUntil, publicSafetyRecordingData(run.plan.config), incidentId)
          writer.query('UPDATE public_safety_sources SET incident_id = ?, uploaded_at_iso = ?, canonical_json = ? WHERE id = ?').run(sourceRow.incident_id!, sourceRow.uploaded_at_iso!, sourceRow.canonical_json!, source.id)
          writer.query('UPDATE public_safety_observations SET source_id = ?, note = ? WHERE id = ?').run(observationRow.source_id!, observationRow.note!, point.id)
        }
        assert.deepEqual(rawSnapshot(), beforeRows)
        assert.deepEqual(await snapshot(), before)
      }
    }
    await assert.rejects(async () => records.appendPublicSafetyReview(config.id, point.id, { ...await reviewInput(), previousReviewId: foreignReview.review.id }), status(404))
    const beforeSourceRace = await snapshot(), sourceVersion = beforeSourceRace.incident.version
    const sourceRace = await Promise.allSettled([17, 18].map(seconds => as(token, () => records.registerPublicSafetySource(config.id, { expectedVersion: sourceVersion, recording: simulatePublicSafety({ config, seconds }) }))))
    assert.equal(sourceRace.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of sourceRace) if (result.status === 'rejected') assert(status(409)(result.reason))
    assert.equal((await records.listPublicSafetySources(config.id)).entries.length, beforeSourceRace.sources.entries.length + 1)
    assert.equal(await version(), sourceVersion + 1)
    assert.equal((await access.readPublicSafetyAudit(config.id)).entries.length, beforeSourceRace.audit.entries.length + 1)
    const beforeReviewRace = await snapshot(), sameReview = await reviewInput()
    const reviewRace = await Promise.allSettled(['First simultaneous review', 'Second simultaneous review'].map(note => as(token, () => records.appendPublicSafetyReview(config.id, point.id, { ...sameReview, note }))))
    assert.equal(reviewRace.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of reviewRace) if (result.status === 'rejected') assert(status(409)(result.reason))
    const afterReviews = await records.listPublicSafetyReviews(config.id, point.id)
    assert.equal(afterReviews.entries.length, beforeReviewRace.reviews[0]!.entries.length + 1)
    assert.equal(afterReviews.entries.at(-1)?.previousReviewId, sameReview.previousReviewId)
    assert.equal(await version(), beforeReviewRace.incident.version + 1)
    assert.equal((await access.readPublicSafetyAudit(config.id)).entries.length, beforeReviewRace.audit.entries.length + 1)
    const beforeMixed = await snapshot(), mixedVersion = beforeMixed.incident.version, mixedReview = await reviewInput()
    const contenders = [
      () => records.registerPublicSafetySource(config.id, { expectedVersion: mixedVersion, recording: simulatePublicSafety({ config, seconds: 19 }) }),
      () => records.appendPublicSafetyObservation(config.id, { expectedVersion: mixedVersion, ...input }),
      () => records.appendPublicSafetyReview(config.id, point.id, mixedReview),
      () => access.changePublicSafetyMembership(config.id, { expectedVersion: mixedVersion, userId: member.id, role: 'observer' }),
      () => access.closePublicSafetyIncident(config.id, { expectedVersion: mixedVersion }),
    ]
    const mixed = await Promise.allSettled(contenders.map(work => as<unknown>(token, work)))
    assert.equal(mixed.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of mixed) if (result.status === 'rejected') assert(status(409)(result.reason))
    const afterMixed = await snapshot(), last = afterMixed.audit.entries.at(-1)!
    assert.equal(afterMixed.incident.version, mixedVersion + 1)
    assert.equal(afterMixed.audit.entries.length, beforeMixed.audit.entries.length + 1)
    assert.equal(last.sequence, mixedVersion + 1)
    assert.equal(afterMixed.sources.entries.length - beforeMixed.sources.entries.length, Number(last.action === 'source-registered'))
    assert.equal(afterMixed.observations.entries.length - beforeMixed.observations.entries.length, Number(last.action === 'observation-created'))
    assert.equal(afterMixed.reviews[0]!.entries.length - beforeMixed.reviews[0]!.entries.length, Number(last.action === 'review-appended'))
    assert.equal(afterMixed.incident.status === 'closed', last.action === 'closed')
    const memberCount = writer.query('SELECT COUNT(*) AS count FROM public_safety_incident_members WHERE incident_id = ? AND user_id = ?').get(incidentId, member.id) as { count: number }
    assert.equal(memberCount.count, Number(last.action === 'member-granted'))
  })
  console.log('PASS native staged-record interleavings and homogeneous mixed mutation races')
}
finally { writer.close(); await database.closeDatabaseConnection() }
