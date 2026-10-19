import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'

type TokenRow = Record<string, string | number | null> & { id: number }
interface Column { name: string, pk: number }
interface ForeignKey { table: string, from: string, to: string }
const identifier = (name: string) => {
  assert(/^[a-z_][a-z0-9_]*$/i.test(name), 'Only actual simple native schema identifiers enter fixture SQL')
  return `"${name}"`
}
/** Independent disposable SQL row-incarnation adversary, never an app token reissue API. */
export async function setupTokenRowExecution(phase: string) {
  const h = await setupMemberExecution(`token-row-${phase}`)
  const { requireIncidentAccess } = await import('../../../resources/functions/drone/public-safety/access/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
  writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
  assert.equal((writer.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
  const columns = writer.query('PRAGMA table_info(oauth_access_tokens)').all() as Column[]
  assert.equal(columns.filter(column => column.pk).length, 1)
  assert.equal(columns.find(column => column.pk)!.name, 'id')
  const originalToken = await h.f.tokens.findToken(h.f.recipientToken)
  assert(originalToken)
  assert.equal(originalToken.id, h.slot.binding.tokenId)
  const originalRow = writer.query('SELECT * FROM oauth_access_tokens WHERE id = ?').get(originalToken.id) as TokenRow
  assert(originalRow)
  assert.deepEqual(Object.keys(originalRow).toSorted(), columns.map(column => column.name).toSorted(), 'Every actual native column is preserved')
  for (const field of ['oauth_grant_id', 'resources', 'audiences', 'workspace_id']) assert.equal(originalRow[field], null, 'The actual no-refresh personal token has no delegation')
  assert.equal(originalRow.revoked, 0)
  assert.equal(originalRow.tokenable_type, originalToken.subjectType)
  assert.equal(originalRow.tokenable_id, originalToken.subjectId)
  assert.equal(originalRow.user_id, originalToken.userId)
  assert.equal(typeof originalRow.token, 'string')
  assert.equal((writer.query('SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE access_token_id = ?').get(originalToken.id) as { count: number }).count, 0)
  const foreignKeys: Array<{ ownerTable: string, column: string, target: string }> = []
  const tables = writer.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  for (const table of tables) {
    const keys = writer.query(`PRAGMA foreign_key_list(${identifier(table.name)})`).all() as ForeignKey[]
    for (const key of keys) {
      if (key.table !== 'oauth_access_tokens') continue
      assert.equal(key.to, 'id', 'Unsupported compound/non-PK token reference must stop this fixture')
      const count = writer.query(`SELECT COUNT(*) AS count FROM ${identifier(table.name)} WHERE ${identifier(key.from)} = ?`).get(originalToken.id) as { count: number }
      assert.equal(count.count, 0, 'Legitimate referencing rows must not be deleted or bypassed')
      foreignKeys.push({ ownerTable: table.name, column: key.from, target: key.to })
    }
  }
  const persisted = (row: TokenRow) => Object.fromEntries(columns.filter(column => column.name !== 'id').map(column => [column.name, row[column.name]]))
  const fields = columns.filter(column => column.name !== 'id').map(column => column.name)
  let newTokenId: number | undefined
  const replace = writer.transaction(() => {
    assert.equal(newTokenId, undefined, 'One atomic token row replacement only')
    const before = writer.query('SELECT * FROM oauth_access_tokens WHERE id = ?').get(originalToken.id) as TokenRow
    assert(before)
    for (const field of ['tokenable_type', 'tokenable_id', 'user_id', 'oauth_client_id', 'token', 'scopes', 'expires_at', 'oauth_grant_id', 'resources', 'audiences', 'workspace_id', 'revoked']) assert.equal(before[field], originalRow[field])
    assert.equal(writer.query('DELETE FROM oauth_access_tokens WHERE id = ?').run(originalToken.id).changes, 1)
    const result = writer.query(`INSERT INTO oauth_access_tokens (${fields.map(identifier).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...fields.map(field => before[field]!))
    const insertedId = Number(result.lastInsertRowid)
    assert(Number.isSafeInteger(insertedId) && insertedId > 0)
    assert.notEqual(insertedId, originalToken.id)
    const row = writer.query('SELECT * FROM oauth_access_tokens WHERE id = ?').get(insertedId) as TokenRow
    assert(row)
    assert.deepEqual(persisted(row), persisted(before), 'Every hash, owner, scope, expiry and timestamp field remains exact')
    assert.equal(writer.query('SELECT id FROM oauth_access_tokens WHERE id = ?').get(originalToken.id), null)
    newTokenId = insertedId
    h.markActorFinished()
    return insertedId
  })
  const currentEligibility = async () => h.f.as(h.f.recipientToken, async () => {
    assert(newTokenId)
    const token = await h.f.tokens.findToken(h.f.recipientToken)
    assert(token)
    assert.equal(token.id, newTokenId, 'The unchanged original bearer resolves through native findToken to the new row ID')
    assert.equal(token.userId, originalToken.userId)
    assert.equal(token.subjectType, originalToken.subjectType)
    assert.equal(token.subjectId, originalToken.subjectId)
    assert.equal(token.clientId, originalToken.clientId)
    assert.deepEqual(token.scopes, originalToken.scopes)
    assert.equal(token.expiresAt?.getTime(), originalToken.expiresAt?.getTime())
    const access = await requireIncidentAccess(h.key, 'source-register')
    assert.equal(access.principal.tokenId, newTokenId)
    assert.equal(access.member.id, h.slot.binding.memberId)
    assert.equal(access.member.version, h.slot.binding.memberVersion)
    assert.equal(await Gate.allows('public-safety:source-register', access.principal.user, h.key), true)
    return token.id
  })
  const assertUnchanged = async (before: Awaited<ReturnType<typeof h.f.snapshot>>, hints: number) => {
    assert.deepEqual(await h.f.snapshot(h.key), before)
    assert.equal(h.hints.length, hints)
    assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
    assert.equal(h.slot.binding.tokenId, originalToken.id, 'No row-incarnation credential is adopted by the original reservation')
    assert.notEqual(h.slot.binding.tokenId, newTokenId)
  }
  const close = async () => {
    // Never restore the original token row or mutate the captured credential for cleanup.
    try { await h.close() }
    finally { writer.close() }
  }
  return { ...h, writer, originalToken, replace, currentEligibility, assertUnchanged, close, newTokenId: () => newTokenId, schemaEvidence: { columns: columns.map(column => column.name), foreignKeys, refreshReferences: 0, foreignKeysEnabled: true, reconstructedAllNonPrimaryFields: true } }
}
