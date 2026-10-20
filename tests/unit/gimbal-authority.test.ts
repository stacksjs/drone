import { expect, test } from 'bun:test'
import { createGimbalAuthority } from '../../resources/functions/drone/payloads/gimbal-authority'

// Public pure seam: lease/directive behavior, not drive hardware or physical stopping.
function config(sourceKind: 'autonomy' | 'operator' = 'autonomy') { return { version: 1, sessionId: 'gimbal-session', epoch: 7, sourceKind, sourceId: 'selected', reference: 'local:7', maxJointAngleRad: [0.25, 0.5, 0.75] } }
function observation(nowMs: number, rest: object = {}) { return { nowMs, reference: 'local:7', authorityGranted: true, neutralRequested: false, manualOverride: false, ...rest } }
function command(issuedAtMs: number, rest: object = {}) { return { version: 1, sessionId: 'gimbal-session', epoch: 7, sourceKind: 'autonomy', sourceId: 'selected', reference: 'local:7', sequence: 1, issuedAtMs, leaseMs: 80, mode: 'joint-angle', jointAngleRad: [0.1, -0.2, 0.3], ...rest } }

test('selected operator and autonomy writers hold only their original issuance lease', () => {
  for (const sourceKind of ['operator', 'autonomy'] as const) {
    const authority = createGimbalAuthority(config(sourceKind))
    expect(Object.keys(authority)).toEqual(['step', 'snapshot', 'retire'])
    expect(authority.snapshot().phase).toBe('waiting')
    const admitted = authority.step(observation(100), command(100, { sourceKind }))
    expect(admitted.commandAccepted).toBe(true)
    expect(admitted.directive).toBe('joint-angle')
    expect(admitted.goalRad).toEqual([0.1, -0.2, 0.3])
    expect(admitted.snapshot.lastAccepted).toEqual({ epoch: 7, sequence: 1, issuedAtMs: 100, expiresAtMs: 180, goalRad: [0.1, -0.2, 0.3] })
    const held = authority.step(observation(140), command(140, { sourceKind: sourceKind === 'operator' ? 'autonomy' : 'operator', sourceId: 'intruder' }))
    expect(held.rejection).toBe('foreign')
    expect(held.commandAccepted).toBe(false)
    expect(held.snapshot.lastAccepted).toEqual(admitted.snapshot.lastAccepted)
    expect(held.goalRad).toEqual([0.1, -0.2, 0.3])
    expect(authority.step(observation(179)).snapshot.lastAccepted).toEqual(admitted.snapshot.lastAccepted)
    const expired = authority.step(observation(180), command(180, { sourceKind, sequence: 2 }))
    expect(expired.snapshot.firstInhibit).toEqual({ atMs: 180, code: 'gimbal-source-expired' })
    expect(expired.directive).toBe('zero-requested-torque')
    expect(expired.goalRad).toBeNull()
    expect(expired.commandAccepted).toBe(false)
    expect(expired.snapshot.counters).toEqual({ observations: 4, acceptedCommands: 1, rejectedForeignCommands: 1, rejectedUnattributedCommands: 0, rejectedSelectedCommands: 0 })
    const unchanged = JSON.stringify(authority.snapshot())
    expect(JSON.stringify(authority.step(observation(181), command(181, { sourceKind, sequence: 3 })).snapshot)).toBe(unchanged)
  }
})

test('safe writer attribution precedes selected scope validation even without a grant', () => {
  for (const rest of [{ sessionId: 'wrong' }, { sessionId: undefined }, { epoch: 8 }]) {
    const authority = createGimbalAuthority(config())
    const result = authority.step(observation(100, { authorityGranted: false }), command(100, rest))
    expect(result.rejection).toBe('selected-invalid')
    expect(result.snapshot.firstInhibit).toEqual({ atMs: 100, code: 'gimbal-command-invalid' })
    expect(result.snapshot.lastAccepted).toBeNull()
  }
  let getters = 0
  const selected = command(100)
  Object.defineProperty(selected, 'jointAngleRad', { enumerable: true, get() { getters++; throw new Error('private') } })
  const authority = createGimbalAuthority(config())
  expect(authority.step(observation(100), selected).snapshot.firstInhibit).toEqual({ atMs: 100, code: 'gimbal-command-invalid' })
  expect(getters).toBe(0)
  const waiting = createGimbalAuthority(config())
  expect(waiting.step(observation(100, { authorityGranted: false }), command(100))).toMatchObject({ commandAccepted: false, rejection: null, directive: 'zero-requested-torque', goalRad: null })
  expect(waiting.snapshot().lastAccepted).toBeNull()
  expect(waiting.snapshot().counters.acceptedCommands).toBe(0)
  expect(waiting.step(observation(120), command(120)).commandAccepted).toBe(true)
  const reference = createGimbalAuthority(config())
  expect(reference.step(observation(100, { authorityGranted: false, reference: 'other' }), command(100)).snapshot.firstInhibit).toEqual({ atMs: 100, code: 'gimbal-reference-changed' })
  const old = createGimbalAuthority(config())
  expect(old.step(observation(180), command(100)).snapshot.firstInhibit).toEqual({ atMs: 180, code: 'gimbal-command-invalid' })
})

test('foreign malformed remainder and unidentifiable identity cannot change the selected token', () => {
  let calls = 0
  const foreign = { sourceKind: 'operator', sourceId: 'foreign', get jointAngleRad() { calls++; throw new Error('private') } }
  const identities = [
    {}, { sourceKind: 'autonomy' }, Object.create({ sourceKind: 'autonomy', sourceId: 'selected' }),
    Object.defineProperty({ sourceKind: 'autonomy' }, 'sourceId', { value: 'selected', enumerable: false }),
    { sourceKind: 'autonomy', get sourceId() { calls++; return 'selected' } },
  ]
  const authority = createGimbalAuthority(config()), admitted = authority.step(observation(100), command(100)).snapshot.lastAccepted
  expect(authority.step(observation(120), foreign).rejection).toBe('foreign')
  for (const packet of identities) {
    const decision = authority.step(observation(140), packet)
    expect(decision.rejection).toBe('unattributed-invalid')
    expect(decision.snapshot.lastAccepted).toEqual(admitted)
    expect(decision.goalRad).toEqual([0.1, -0.2, 0.3])
  }
  expect(calls).toBe(0)
  expect(authority.snapshot().firstInhibit).toBeNull()
  expect(authority.snapshot().counters).toEqual({ observations: 7, acceptedCommands: 1, rejectedForeignCommands: 1, rejectedUnattributedCommands: 5, rejectedSelectedCommands: 0 })
})

test('selected replay, scope, issuance, lease, travel and unsupported rates latch literal causes', () => {
  for (const rest of [{ sequence: 1 }, { sequence: 2, issuedAtMs: 100 }, { sequence: 1, jointAngleRad: [0.2, 0, 0] }]) {
    const authority = createGimbalAuthority(config())
    authority.step(observation(100), command(100))
    const result = authority.step(observation(120), command(120, rest))
    expect(result.rejection).toBe('selected-invalid')
    expect(result.snapshot.firstInhibit).toEqual({ atMs: 120, code: 'gimbal-command-replay' })
    expect(result.snapshot.lastAccepted!.sequence).toBe(1)
    expect(result.goalRad).toBeNull()
  }
  for (const rest of [
    { mode: 'joint-rate' }, { reference: 'wrong' }, { epoch: 8 }, { sessionId: 'wrong' },
    { sequence: 0 }, { sequence: 4294967296 }, { issuedAtMs: 201 }, { issuedAtMs: 99 },
    { issuedAtMs: 100, leaseMs: 100 }, { leaseMs: 19 }, { leaseMs: 101 }, { leaseMs: 20.5 },
    { jointAngleRad: [0.25000000000000006, 0, 0] }, { jointAngleRad: [NaN, 0, 0] },
    { jointAngleRad: [0, , 0] }, { jointAngleRad: [0, 0] }, { extra: true },
  ]) {
    const authority = createGimbalAuthority(config())
    const result = authority.step(observation(200), command(200, rest))
    expect(result.snapshot.firstInhibit).toEqual({ atMs: 200, code: 'gimbal-command-invalid' })
    expect(result.commandAccepted).toBe(false)
    expect(result.snapshot.counters.rejectedSelectedCommands).toBe(1)
  }
  for (const jointAngleRad of [[0.25, -0.5, 0.75], [-0.25, 0.5, -0.75]]) {
    const authority = createGimbalAuthority(config())
    expect(authority.step(observation(200), command(101, { leaseMs: 100, jointAngleRad })).commandAccepted).toBe(true)
  }
  const authority = createGimbalAuthority(config())
  authority.step(observation(100), command(100))
  expect(authority.step(observation(120), command(120, { sequence: 2 })).snapshot.lastAccepted).toEqual({ epoch: 7, sequence: 2, issuedAtMs: 120, expiresAtMs: 200, goalRad: [0.1, -0.2, 0.3] })
})

test('inputs and returned snapshots are detached and proxy or accessor code is never invoked', () => {
  const cfg = config(), authority = createGimbalAuthority(cfg), packet = command(100)
  cfg.maxJointAngleRad[0] = 0.01
  const decision = authority.step(observation(100), packet)
  packet.jointAngleRad[0] = 0.24
  decision.goalRad![0] = 0.24
  decision.snapshot.lastAccepted!.goalRad[0] = 0.24
  decision.snapshot.selection.maxJointAngleRad[0] = 0.01
  expect(authority.snapshot().selection.maxJointAngleRad).toEqual([0.25, 0.5, 0.75])
  expect(authority.step(observation(120)).goalRad).toEqual([0.1, -0.2, 0.3])
  let calls = 0
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error('private') }, ownKeys() { calls++; throw new Error('private') }, getOwnPropertyDescriptor() { calls++; throw new Error('private') }, get() { calls++; throw new Error('private') } })
  expect(() => createGimbalAuthority(proxy)).toThrow('gimbal-authority-input')
  expect(authority.step(observation(140), proxy).rejection).toBe('unattributed-invalid')
  const observed = createGimbalAuthority(config())
  expect(observed.step(proxy).snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-observation-invalid' })
  expect(calls).toBe(0)
  const tupleProxy = Proxy.revocable([0, 0, 0], {})
  tupleProxy.revoke()
  const selected = createGimbalAuthority(config())
  expect(selected.step(observation(100), command(100, { jointAngleRad: tupleProxy.proxy })).snapshot.firstInhibit).toEqual({ atMs: 100, code: 'gimbal-command-invalid' })
})

test('trusted stop priorities latch once and never imply instantaneous physical stopping', () => {
  for (const [rest, code] of [
    [{ manualOverride: true, neutralRequested: true, authorityGranted: false, reference: 'other' }, 'gimbal-manual-override'],
    [{ neutralRequested: true, authorityGranted: false, reference: 'other' }, 'gimbal-operator-neutral'],
    [{ authorityGranted: false, reference: 'other' }, 'gimbal-authority-unavailable'],
    [{ reference: 'other' }, 'gimbal-reference-changed'],
  ] as const) {
    const authority = createGimbalAuthority(config())
    authority.step(observation(100), command(100, { leaseMs: 20 }))
    const stopped = authority.step(observation(120, rest), command(120, { sequence: 2 }))
    expect(stopped.snapshot.firstInhibit).toEqual({ atMs: 120, code })
    expect(stopped.directive).toBe('zero-requested-torque')
    expect(stopped.goalRad).toBeNull()
    expect(stopped.snapshot.lastAccepted!.issuedAtMs).toBe(100)
    const before = JSON.stringify(stopped.snapshot)
    expect(JSON.stringify(authority.step(observation(140), command(140, { sequence: 3 })).snapshot)).toBe(before)
    expect(authority.retire(140).firstInhibit).toEqual({ atMs: 120, code })
  }
})

test('clock preflight order and exact observation capacity never fabricate a fault epoch', () => {
  for (const n of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '100']) {
    const authority = createGimbalAuthority(config())
    expect(authority.step({ ...observation(100), nowMs: n }).snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-clock-discontinuity' })
    expect(authority.snapshot().counters.observations).toBe(0)
  }
  const malformed = createGimbalAuthority(config())
  expect(malformed.step({ ...observation(NaN), authorityGranted: 'yes' }).snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-observation-invalid' })
  const reversed = createGimbalAuthority(config())
  reversed.step(observation(100))
  expect(reversed.step(observation(99)).snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-clock-discontinuity' })
  expect(reversed.snapshot().counters.observations).toBe(1)
  for (const gap of [false, true]) {
    const authority = createGimbalAuthority(config())
    for (let i = 0; i < 4096; i++) authority.step(observation(100))
    expect(authority.snapshot().counters.observations).toBe(4096)
    const failed = authority.step(observation(gap ? 141 : 100), command(100))
    expect(failed.snapshot.firstInhibit).toEqual({ atMs: gap ? 141 : 100, code: gap ? 'gimbal-policy-gap' : 'gimbal-counter-exhausted' })
    expect(failed.snapshot.counters).toEqual({ observations: 4096, acceptedCommands: 0, rejectedForeignCommands: 0, rejectedUnattributedCommands: 0, rejectedSelectedCommands: 0 })
    expect(authority.retire(gap ? 140 : 99)).toEqual(failed.snapshot)
    const retired = authority.retire(gap ? 141 : 100)
    expect(retired.phase).toBe('retired')
    expect(retired.counters.observations).toBe(4096)
    expect(retired.transitions.at(-1)).toEqual({ atMs: gap ? 141 : 100, from: 'inhibited', to: 'retired', reason: 'session-retired' })
  }
  const boundary = createGimbalAuthority(config())
  boundary.step(observation(100))
  expect(boundary.step(observation(140)).snapshot.firstInhibit).toBeNull()
})

test('normal retirement closes waiting, active and inhibited sessions without a new fault or counters', () => {
  for (const active of [false, true]) {
    const authority = createGimbalAuthority(config())
    if (active) authority.step(observation(100), command(100))
    const before = authority.snapshot(), retired = authority.retire(2000)
    expect(retired.phase).toBe('retired')
    expect(retired.firstInhibit).toBeNull()
    expect(retired.counters).toEqual(before.counters)
    expect(retired.lastAccepted).toEqual(before.lastAccepted)
    expect(retired.transitions.at(-1)).toEqual({ atMs: 2000, from: active ? 'active' : 'waiting', to: 'retired', reason: 'session-retired' })
    const unchanged = JSON.stringify(retired)
    expect(JSON.stringify(authority.retire(NaN))).toBe(unchanged)
    const inert = authority.step(null, { get sourceKind() { throw new Error('must not run') } })
    expect(inert.goalRad).toBeNull()
    expect(inert.directive).toBe('zero-requested-torque')
    expect(inert.rejection).toBe('retired')
    expect(JSON.stringify(inert.snapshot)).toBe(unchanged)
  }
  for (const active of [false, true]) {
    const authority = createGimbalAuthority(config())
    if (active) authority.step(observation(100), command(100))
    const inhibited = authority.retire(active ? 99 : Infinity)
    expect(inhibited.phase).toBe('inhibited')
    expect(inhibited.firstInhibit).toEqual({ atMs: null, code: 'gimbal-clock-discontinuity' })
    expect(authority.retire(NaN)).toEqual(inhibited)
    expect(authority.step(null).snapshot).toEqual(inhibited)
    const retired = authority.retire(100)
    expect(retired.firstInhibit).toEqual(inhibited.firstInhibit)
    expect(retired.counters).toEqual(inhibited.counters)
    expect(retired.transitions.at(-1)).toEqual({ atMs: 100, from: 'inhibited', to: 'retired', reason: 'session-retired' })
  }
  const capped = createGimbalAuthority(config())
  for (let i = 0; i < 4096; i++) capped.step(observation(100))
  expect(capped.retire(2000).firstInhibit).toBeNull()
  expect(capped.snapshot().counters.observations).toBe(4096)
  expect(Object.keys(capped.snapshot())).toEqual(['version', 'phase', 'selection', 'lastAccepted', 'firstInhibit', 'counters', 'transitions'])
  expect(Buffer.byteLength(JSON.stringify(capped.snapshot()) + '\n')).toBeLessThanOrEqual(8192)
  expect(Buffer.byteLength(JSON.stringify(capped.step(null)) + '\n')).toBeLessThanOrEqual(12288)
})

test('constructor data, bounds and stage1 structure remain closed with fixed errors', () => {
  let reads = 0
  const accessor = Object.defineProperty(config(), 'sourceId', { enumerable: true, get() { reads++; throw new Error('private') } })
  for (const input of [null, [], accessor, { ...config(), extra: true }, { ...config(), epoch: 0 }, { ...config(), epoch: 4294967296 }, { ...config(), sourceId: '' }, { ...config(), sessionId: 'x'.repeat(65) }, { ...config(), reference: '\n' }, { ...config(), maxJointAngleRad: [0, 1, 1] }, { ...config(), maxJointAngleRad: [Math.PI + 1, 1, 1] }]) {
    expect(() => createGimbalAuthority(input)).toThrow(new TypeError('gimbal-authority-input'))
  }
  expect(reads).toBe(0)
  const upper = createGimbalAuthority({ ...config(), epoch: 4294967295, sessionId: 'a'.repeat(64), reference: 'a'.repeat(96), maxJointAngleRad: [Math.PI, Math.PI, Math.PI] })
  expect(upper.snapshot().selection.epoch).toBe(4294967295)
  for (const invalid of [{ extra: true }, { reference: '' }, { neutralRequested: 1 }]) {
    const authority = createGimbalAuthority(config())
    for (let i = 0; i < 4096; i++) authority.step(observation(100))
    const failed = authority.step({ ...observation(NaN), ...invalid })
    expect(failed.snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-observation-invalid' })
    expect(failed.snapshot.counters.observations).toBe(4096)
  }
  const clock = createGimbalAuthority(config())
  for (let i = 0; i < 4096; i++) clock.step(observation(100))
  expect(clock.step(observation(99)).snapshot.firstInhibit).toEqual({ atMs: null, code: 'gimbal-clock-discontinuity' })
  const hidden = command(100)
  Object.defineProperty(hidden, 'sequence', { value: 1, enumerable: false })
  expect(createGimbalAuthority(config()).step(observation(100), hidden).rejection).toBe('selected-invalid')
  const missing = command(100)
  Reflect.deleteProperty(missing, 'sessionId')
  expect(createGimbalAuthority(config()).step(observation(100), missing).rejection).toBe('selected-invalid')
})
