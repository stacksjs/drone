import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'
import { planPublicSafetyMission } from '../../../resources/functions/drone/public-safety/planner'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'

type SqlRow = Record<string, string | number | null>

/** Existing independent owned SQLite adversary changes only a valid full config. */
export async function setupConfigExecution(phase: string) {
  const h = await setupMemberExecution(`config-${phase}`)
  const { requireIncidentAccess } = await import('../../../resources/functions/drone/public-safety/access/policy')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
  writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
  const snapshot = () => {
    const incident = writer.query('SELECT * FROM public_safety_incidents WHERE incident_key = ?').get(h.key) as SqlRow
    assert(incident && typeof incident.id === 'number')
    return {
      incident,
      members: writer.query('SELECT * FROM public_safety_incident_members WHERE incident_id = ? ORDER BY id ASC').all(incident.id) as SqlRow[],
      audits: writer.query('SELECT * FROM public_safety_audits WHERE incident_id = ? ORDER BY sequence ASC').all(incident.id) as SqlRow[],
    }
  }
  const original = snapshot()
  assert.equal(original.incident.config_json, h.slot.binding.configJson)
  const oldConfig = planPublicSafetyMission(JSON.parse(String(original.incident.config_json))).config
  const changedConfig = structuredClone(oldConfig)
  changedConfig.noObserveZones = [[[-.65, -.65], [-.45, -.65], [-.45, -.45], [-.65, -.45]]]
  const validated = planPublicSafetyMission(changedConfig).config
  const nextJson = publicSafetyRecordingData(validated)
  assert.notEqual(nextJson, original.incident.config_json)
  assert.notDeepEqual(validated.noObserveZones, oldConfig.noObserveZones)
  assert.deepEqual({ ...validated, noObserveZones: oldConfig.noObserveZones }, oldConfig, 'Only the valid privacy polygon changes; identity, purpose and retention stay exact')
  let replacement: ReturnType<typeof snapshot> | undefined
  const replace = () => {
    assert.equal(replacement, undefined, 'The real persisted full configuration changes exactly once')
    writer.transaction(() => {
      const result = writer.query('UPDATE public_safety_incidents SET config_json = ? WHERE id = ? AND version = ? AND config_json = ?').run(nextJson, original.incident.id!, original.incident.version!, String(original.incident.config_json))
      assert.equal(result.changes, 1)
    }).immediate()
    replacement = snapshot()
    assert.equal(replacement.incident.config_json, nextJson)
    const { config_json: changedJson, ...currentFields } = replacement.incident
    const { config_json: oldJson, ...originalFields } = original.incident
    assert.notEqual(changedJson, oldJson)
    assert.deepEqual(currentFields, originalFields, 'Native key/revision/purpose/retention/CAS/incarnation and timestamps are preserved')
    assert.deepEqual(replacement.members, original.members)
    assert.deepEqual(replacement.audits, original.audits)
    h.markActorFinished()
    return { snapshot: replacement, hints: h.hints.length }
  }
  const currentEligibility = async () => {
    assert(replacement)
    const current = await h.f.as(h.f.recipientToken, () => requireIncidentAccess(h.key, 'source-register'))
    assert.equal(current.incident.id, original.incident.id)
    assert.equal(current.member.id, h.original.member.id)
    assert.equal(current.member.role, h.slot.binding.role)
    assert.equal(current.member.version, h.slot.binding.memberVersion)
    const workspace = await h.f.as(h.f.recipientToken, () => readWorkspaceAccess(h.key))
    assert.notEqual(workspace.scope, h.scope, 'The actual full-config scope changes with all identity columns preserved')
    return workspace.scope
  }
  const scopeConflict = (error: unknown) => error instanceof h.f.access.PublicSafetyAccessError && error.status === 409 && error.message === 'Workspace scope has changed'
  const sourceConfigConflict = (error: unknown) => error instanceof h.f.access.PublicSafetyAccessError && error.status === 422 && error.message === 'Source does not match this incident scope'
  const unchanged = (after: ReturnType<typeof replace>) => {
    assert.deepEqual(snapshot(), after.snapshot)
    assert.equal(h.hints.length, after.hints)
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(original.incident.id!) as { count: number }).count, 0)
    assert.equal(h.slot.binding.configJson, original.incident.config_json, 'Original execution config is never replaced by current policy')
  }
  const close = async () => {
    try { await h.close() }
    finally { writer.close() }
  }
  return { ...h, writer, originalRows: original, replace, currentEligibility, scopeConflict, sourceConfigConflict, unchanged, close }
}
