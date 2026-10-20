import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import vectors from '../fixtures/patrol-review/canonical-vectors.json'
import { createRequestDigest, digests, isPatrolDatabaseBusy, iso, json, normalizeBinding, normalizeConsume, normalizeCreate, normalizeDecision, normalizeInput, routeDue, scopeDigest, utcMs } from '../../resources/functions/drone/navigation/review/contract'

// Pure canonical policy seam, not native authentication or transaction evidence.
test('patrol canonical bytes and SHA256 match independent literal owner key tuple and version vectors', () => {
  const body = normalizeCreate(vectors.body)
  expect(json(body.input, 1024)).toBe(vectors.inputBytes)
  expect(json(body.binding, 1024)).toBe(vectors.bindingBytes)
  const hashes = digests(body.input, body.binding)
  expect(hashes).toEqual({ inputDigest: vectors.inputDigest, bindingDigest: vectors.bindingDigest })
  expect(createRequestDigest(7, body)).toBe(vectors.createOwner7)
  for (const [owner, key, due, expected] of [
    [7, 'vector', 1767225600000, vectors.scopeOwner7KeyVectorA],
    [8, 'vector', 1767225600000, vectors.scopeOwner8KeyVectorA],
    [7, 'other', 1767225600000, vectors.scopeOwner7OtherKeyA],
    [7, 'vector', 1767225660000, vectors.scopeOwner7KeyVectorB],
  ] as const) expect(scopeDigest(owner, key, due, hashes.inputDigest, hashes.bindingDigest)).toBe(expected)
})

test('patrol materialization fixes property order and commits original decision expectedVersion to digest', async () => {
  const { transitionDigest } = await import('../../resources/functions/drone/navigation/review/contract')
  const body = vectors.body
  const reversed = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).reverse())
  expect(normalizeCreate(reversed({ ...body, binding: reversed(body.binding), input: reversed(body.input) }))).toEqual(normalizeCreate(body))
  const decision = { expectedVersion: 1, requestId: '22222222-2222-4222-8222-222222222222', scopeDigest: vectors.scopeOwner7KeyVectorA, decision: 'approve' }
  expect(transitionDigest(7, 'vector', 1767225600000, 'approve', normalizeDecision(reversed(decision)))).toBe(vectors.approveVersion1)
  expect(transitionDigest(7, 'vector', 1767225600000, 'approve', normalizeDecision({ ...decision, expectedVersion: 2 }))).toBe(vectors.approveVersion2)
  expect(transitionDigest(7, 'vector', 1767225600000, 'deny', normalizeDecision({ ...decision, decision: 'deny' }))).toBe(vectors.denyVersion1)
  expect(transitionDigest(7, 'vector', 1767225600000, 'consume', normalizeConsume({ expectedVersion: 2, requestId: '33333333-3333-4333-8333-333333333333', scopeDigest: decision.scopeDigest }))).toBe(vectors.consumeVersion2)
})

test('patrol unknown objects and dense own-data arrays reject traps accessors inherited symbols holes and extras', () => {
  let reads = 0
  const getter = { ...vectors.body }
  Object.defineProperty(getter, 'input', { enumerable: true, get() {
    reads++
    return vectors.body.input
  } })
  assert.throws(() => normalizeCreate(getter), TypeError)
  const proxy = new Proxy(vectors.body, { getPrototypeOf() {
    reads++
    throw new Error('must not execute')
  } })
  assert.throws(() => normalizeCreate(proxy), TypeError)
  for (const value of [Object.assign(Object.create(null), vectors.body), Object.assign(Object.create({ owner: 7 }), vectors.body), { ...vectors.body, extra: false }, { ...vectors.body, [Symbol('extra')]: 1 }]) assert.throws(() => normalizeCreate(value), TypeError)
  const sparse = new Array(2)
  sparse[1] = vectors.body.input.decisions[1]
  const accessed = [vectors.body.input.decisions[0]]
  Object.defineProperty(accessed, '0', { enumerable: true, get() {
    reads++
    return vectors.body.input.decisions[0]
  } })
  const symbol = [...vectors.body.input.decisions]
  Object.defineProperty(symbol, Symbol.iterator, { value() {
    reads++
    return [][Symbol.iterator]()
  } })
  const hidden = [...vectors.body.input.decisions]
  Object.defineProperty(hidden, 'hidden', { value: 1 })
  const inherited = Object.setPrototypeOf([...vectors.body.input.decisions], Object.create(Array.prototype))
  for (const decisions of [sparse, accessed, symbol, hidden, inherited, [...vectors.body.input.decisions, vectors.body.input.decisions[0]]]) assert.throws(() => normalizeInput({ ...vectors.body.input, decisions }), TypeError)
  expect(reads).toBe(0)
})

test('patrol declared IDs exact origin reference date and UTC limits reject noncanonical or overflowing values', () => {
  const binding = vectors.body.binding
  const maximal = { ...binding, sessionId: '18446744073709551615', bootId: '18446744073709551615', reference: '18446744073709551615:9007199254740991,9007199254740991,9007199254740991,9007199254740991,9007199254740991' }
  assert.deepEqual(normalizeBinding(maximal), maximal)
  expect(maximal.reference.length).toBe(105)
  for (const changed of [{ sessionId: '18446744073709551616' }, { sessionId: '0' }, { bootId: '055' }, { reference: '54:0,0,0,0,0' }, { reference: '55:9007199254740992,0,0,0,0' }, { reference: '55:00,0,0,0,0' }, { origin: '{"latitudeDeg":-0,"longitudeDeg":0,"ellipsoidHeightM":100}' }]) assert.throws(() => normalizeBinding({ ...binding, ...changed }), TypeError)
  expect(iso('1970-01-01T00:00:00.000Z')).toBe('1970-01-01T00:00:00.000Z')
  expect(iso('9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z')
  expect(utcMs(253402300799999)).toBe(253402300799999)
  for (const value of [-0, -1, 253402300800000, Number.NaN, Infinity, 1.5, '0', true]) assert.throws(() => utcMs(value), TypeError)
  for (const value of ['2026-02-30T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00.000Z\n']) assert.throws(() => iso(value), TypeError)
  for (const value of ['01767225600000', '-0', '1e3', '+1', ' 1', 'NaN']) assert.throws(() => routeDue(value), TypeError)
})

test('patrol decision and consume accept exactly owned fields versions UUIDs and digests', () => {
  const decision = { expectedVersion: 1, requestId: vectors.body.requestId, scopeDigest: vectors.scopeOwner7KeyVectorA, decision: 'deny' }
  assert.deepEqual(normalizeDecision(decision), decision)
  for (const changed of [{ expectedVersion: 0 }, { expectedVersion: 6 }, { expectedVersion: '1' }, { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() }, { scopeDigest: 'a'.repeat(63) }, { scopeDigest: 'A'.repeat(64) }, { decision: 'approve ' }, { ownerUserId: 7 }]) assert.throws(() => normalizeDecision({ ...decision, ...changed }), TypeError)
  const consume = { expectedVersion: 5, requestId: decision.requestId, scopeDigest: decision.scopeDigest }
  expect(normalizeConsume(consume)).toEqual(consume)
  assert.throws(() => normalizeConsume({ ...consume, decision: 'approve' }), TypeError)
})

// These are classifier controls, not evidence that a native conflict occurred.
test('patrol busy classification accepts only the two observed native Error identities', () => {
  for (const [code, errno] of [['SQLITE_BUSY', 5], ['SQLITE_BUSY_SNAPSHOT', 517]] as const) {
    expect(isPatrolDatabaseBusy(Object.assign(new Error('unrelated text'), { code, errno }))).toBe(true)
    expect(isPatrolDatabaseBusy({ code, errno })).toBe(false)
    expect(isPatrolDatabaseBusy(Object.assign(new Error(code), { code, errno: String(errno) }))).toBe(false)
  }
  for (const [code, errno] of [['SQLITE_BUSY', 517], ['SQLITE_BUSY_SNAPSHOT', 5], ['SQLITE_LOCKED', 6], ['SQLITE_BUSY_RECOVERY', 261], ['SQLITE_IOERR', 10], ['SQLITE_CONSTRAINT_UNIQUE', 2067]]) {
    expect(isPatrolDatabaseBusy(Object.assign(new Error('database is locked'), { code, errno }))).toBe(false)
  }
  for (const value of [null, undefined, 'SQLITE_BUSY_SNAPSHOT', new Error('SQLITE_BUSY 5')]) expect(isPatrolDatabaseBusy(value)).toBe(false)
})
