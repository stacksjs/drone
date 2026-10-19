import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'

type SqlRow = Record<string, string | number | null>

/** Independent fixture adversary from the qualified registration replacement case. */
export async function setupIncarnationExecution(phase: string) {
  const h = await setupMemberExecution(`incarnation-${phase}`)
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
  assert.equal(original.incident.id, h.slot.binding.incidentId)
  assert.equal(original.incident.created_at, h.slot.binding.createdAt)
  assert.equal(original.members.length, 2)
  assert(original.members.some(member => member.id === h.original.member.id && member.role === 'pilot'))
  assert(original.members.some(member => member.user_id === h.f.sender.id && member.role === 'coordinator'))
  let replacement: ReturnType<typeof snapshot> | undefined
  const replace = () => {
    assert.equal(replacement, undefined, 'The real native rows are replaced once')
    assert(typeof original.incident.id === 'number')
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(original.incident.id) as { count: number }).count, 0)
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_retention_scopes WHERE incident_id = ?').get(original.incident.id) as { count: number }).count, 0)
    // No source, handover or managed artifact is created. Existing FK restrictions
    // remain enabled; an unexpected dependency fails instead of expanding deletion.
    writer.query('DELETE FROM public_safety_audits WHERE incident_id = ?').run(original.incident.id)
    writer.query('DELETE FROM public_safety_incident_members WHERE incident_id = ?').run(original.incident.id)
    writer.query('DELETE FROM public_safety_incidents WHERE id = ?').run(original.incident.id)
    const { id, ...incident } = original.incident
    assert.equal(id, h.slot.binding.incidentId)
    incident.created_at = new Date(Math.max(Date.now() + 1, Date.parse(String(original.incident.created_at)) + 1)).toISOString()
    const fields = Object.keys(incident)
    writer.query(`INSERT INTO public_safety_incidents (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(incident))
    const newIncident = writer.query('SELECT * FROM public_safety_incidents WHERE incident_key = ?').get(h.key) as SqlRow
    assert(typeof newIncident.id === 'number')
    assert.notEqual(newIncident.id, original.incident.id)
    assert.notEqual(newIncident.created_at, original.incident.created_at)
    assert(Number.isFinite(Date.parse(String(newIncident.created_at))))
    for (const old of original.members) {
      assert(typeof old.user_id === 'number')
      const { id: memberId, ...member } = old
      member.incident_id = newIncident.id
      const memberFields = Object.keys(member)
      writer.query(`INSERT INTO public_safety_incident_members (${memberFields.join(',')}) VALUES (${memberFields.map(() => '?').join(',')})`).run(...Object.values(member))
      const current = writer.query('SELECT * FROM public_safety_incident_members WHERE incident_id = ? AND user_id = ?').get(newIncident.id, old.user_id) as SqlRow
      assert.notEqual(current.id, memberId)
      const { id: currentId, ...currentFields } = current
      assert(typeof currentId === 'number')
      assert.deepEqual(currentFields, member, 'Both coordinator and pilot retain actual current eligibility')
    }
    const { id: newId, created_at: newCreatedAt, ...newFields } = newIncident
    const { id: oldId, created_at: oldCreatedAt, ...oldFields } = original.incident
    assert.notEqual(newId, oldId)
    assert.notEqual(newCreatedAt, oldCreatedAt)
    assert.deepEqual(newFields, oldFields, 'Full config, key, revision, purpose, retention and native CAS are unchanged')
    replacement = snapshot()
    h.markActorFinished()
    return { snapshot: replacement, hints: h.hints.length }
  }
  const currentEligibility = async () => {
    assert(replacement)
    const current = await h.f.as(h.f.recipientToken, () => requireIncidentAccess(h.key, 'source-register'))
    assert.equal(current.incident.id, replacement.incident.id)
    assert.notEqual(current.member.id, h.slot.binding.memberId)
    assert.equal(current.member.role, h.slot.binding.role)
    assert.equal(current.member.version, h.slot.binding.memberVersion)
    const currentWorkspace = await h.f.as(h.f.recipientToken, () => readWorkspaceAccess(h.key))
    assert.notEqual(currentWorkspace.scope, h.scope)
    return currentWorkspace.scope
  }
  const scopeConflict = (error: unknown) => error instanceof h.f.access.PublicSafetyAccessError && error.status === 409 && error.message === 'Workspace scope has changed'
  const unchanged = (after: ReturnType<typeof replace>) => {
    assert.deepEqual(snapshot(), after.snapshot)
    assert.equal(h.hints.length, after.hints)
    assert(typeof after.snapshot.incident.id === 'number')
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(after.snapshot.incident.id) as { count: number }).count, 0)
    assert.equal(h.slot.binding.incidentId, original.incident.id)
    assert.equal(h.slot.binding.createdAt, original.incident.created_at)
    assert.equal(h.slot.binding.memberId, h.original.member.id)
  }
  const close = async () => {
    try { await h.close() }
    finally { writer.close() }
  }
  return { ...h, writer, originalRows: original, replace, currentEligibility, scopeConflict, unchanged, close }
}
