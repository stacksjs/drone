import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { retainedPreview } from '../../helpers/public-safety-retained'
import { setupMemberExecution } from './execution-member-setup'

type SqlRow = Record<string, string | number | null>

/** Genuine future custody enrollment, then one independent existing freeze-state actor. */
export async function setupFreezeExecution(phase: string) {
  const h = await setupMemberExecution(`freeze-${phase}`)
  const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
  const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  for (const ability of ['read', 'manage'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
  const preview = await h.f.as(h.f.senderToken, async () => retainedPreview(await retention.previewPublicSafetyRetention(h.key)))
  assert.equal(preview.expired, false)
  assert.deepEqual(preview.counts, { sources: 0, observations: 0, reviews: 0 })
  const enrolled = await h.f.as(h.f.senderToken, () => retention.enrollPublicSafetyRetention(h.key, { expectedVersion: preview.incidentVersion, inventoryDigest: preview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: crypto.randomUUID() }))
  assert.equal(enrolled.replayed, false)
  assert.equal(enrolled.scope.version, 1)
  assert.equal(enrolled.scope.incidentVersion, preview.incidentVersion + 1)
  assert(Date.parse(enrolled.scope.retainUntil) > Date.now() + 60000)
  assert.equal((await h.f.as(h.f.recipientToken, () => readWorkspaceAccess(h.key))).scope, h.scope, 'Real enrollment sequence advancement alone preserves the original full-config scope')
  assert.equal((await h.core.readIncidentExecution(h.context, { scope: h.scope }))?.execution, h.started.execution, 'Original owner binding survives genuine enrollment')
  const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
  writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
  const snapshot = () => {
    const incident = writer.query('SELECT * FROM public_safety_incidents WHERE incident_key = ?').get(h.key) as SqlRow
    assert(incident && typeof incident.id === 'number')
    const scope = writer.query('SELECT * FROM public_safety_retention_scopes WHERE incident_id = ?').get(incident.id) as SqlRow
    assert(scope && typeof scope.id === 'number')
    return {
      incident, scope,
      members: writer.query('SELECT * FROM public_safety_incident_members WHERE incident_id = ? ORDER BY id ASC').all(incident.id) as SqlRow[],
      audits: writer.query('SELECT * FROM public_safety_audits WHERE incident_id = ? ORDER BY sequence ASC').all(incident.id) as SqlRow[],
      retentionEvents: writer.query('SELECT * FROM public_safety_retention_events WHERE scope_id = ? ORDER BY sequence ASC').all(scope.id) as SqlRow[],
    }
  }
  const original = snapshot()
  const expectedVersion = Number(original.incident.version)
  assert.equal(expectedVersion, enrolled.scope.incidentVersion)
  assert.equal(original.scope.version, 1)
  assert.equal(original.scope.freeze_state, 'retained')
  assert.equal(original.incident.config_json, h.slot.binding.configJson)
  assert.equal(original.retentionEvents.length, 1)
  assert.equal(original.retentionEvents[0]!.action, 'enrolled')
  assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_purges WHERE incident_id = ?').get(original.incident.id!) as { count: number }).count, 0)
  let frozen: ReturnType<typeof snapshot> | undefined
  const freeze = () => {
    assert.equal(frozen, undefined)
    writer.transaction(() => {
      const result = writer.query('UPDATE public_safety_retention_scopes SET freeze_state = ? WHERE id = ? AND incident_id = ? AND version = ? AND freeze_state = ?').run('frozen', original.scope.id!, original.incident.id!, original.scope.version!, 'retained')
      assert.equal(result.changes, 1)
    }).immediate()
    frozen = snapshot()
    assert.equal(frozen.scope.freeze_state, 'frozen')
    assert.deepEqual({ ...frozen.scope, freeze_state: 'retained' }, original.scope, 'Only existing freeze_state changes; no scope version/deadline/hold rewrite')
    assert.deepEqual(frozen.incident, original.incident)
    assert.deepEqual(frozen.members, original.members)
    assert.deepEqual(frozen.audits, original.audits)
    assert.deepEqual(frozen.retentionEvents, original.retentionEvents)
    h.markActorFinished()
    return { snapshot: frozen, hints: h.hints.length }
  }
  const freezeConflict = (error: unknown) => error instanceof h.f.access.PublicSafetyAccessError && error.status === 409 && error.message === 'Incident is frozen for accepted purge'
  const assertCurrentFrozen = async () => { await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), freezeConflict) }
  const unchanged = (after: ReturnType<typeof freeze>) => {
    assert.deepEqual(snapshot(), after.snapshot)
    assert.equal(h.hints.length, after.hints)
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(original.incident.id!) as { count: number }).count, 0)
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_purges WHERE incident_id = ?').get(original.incident.id!) as { count: number }).count, 0)
    assert.equal(h.slot.binding.configJson, original.incident.config_json)
    assert.equal(h.slot.binding.incidentId, original.incident.id)
    assert.equal(h.slot.binding.memberVersion, h.original.member.version)
  }
  const close = async () => { try { await h.close() } finally { writer.close() } }
  return { ...h, writer, originalRows: original, expectedVersion, freeze, freezeConflict, assertCurrentFrozen, unchanged, close }
}
