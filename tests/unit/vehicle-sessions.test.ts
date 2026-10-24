import { expect, test } from 'bun:test'
import { createVehicleSimulationSession } from '../../resources/functions/drone/vehicles/runtime'
import { createMultirotorProfile } from '../../resources/functions/drone/vehicles/multirotor/profile'
import type { VehiclePayloadCommand } from '../../resources/functions/drone/vehicles/types'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'

test('two vehicle sessions share policy epochs while their raw sensor and authority scopes remain distinct', () => {
  const a = createVehicleSimulationSession(createMultirotorProfile(), { seconds: 2, scope: { bootId: 101n, sessionId: 201n } })
  const b = createVehicleSimulationSession(createMultirotorProfile(), { seconds: 2, scope: { bootId: 102n, sessionId: 202n } })
  try {
    expect(() => a.result()).toThrow('still active')
    for (let nowMs = 0; nowMs <= 1000; nowMs += 4) {
      const left = a.step(nowMs), right = b.step(nowMs)
      expect(left.atMs).toBe(right.atMs)
      expect(left.board.bootId).toBe(101n)
      expect(right.board.bootId).toBe(102n)
      if (nowMs === 1000) {
        expect(left.reference.startsWith('101:')).toBe(true)
        expect(right.reference.startsWith('102:')).toBe(true)
        expect(left.authority.sessionId).toBe(201n)
        expect(right.authority.sessionId).toBe(202n)
        expect(left.authority.state).toBe('autonomous')
        expect(right.authority.state).toBe('autonomous')
        expect(left.board.actuators.some(n => n > 0)).toBe(true)
        expect(right.board.actuators.some(n => n > 0)).toBe(true)
        expect(left.policyAtMs).toBe(1000)
        expect(right.policyAtMs).toBe(1000)
      }
    }
  }
  finally { a.close(); b.close() }
  expect(a.result().board.actuators).toEqual([0, 0, 0, 0])
  expect(b.result().board.actuators).toEqual([0, 0, 0, 0])
})

test('one vehicle can lose its host and settle independently while the peer continues fresh policy', () => {
  const profile = createMultirotorProfile(), original = profile.faults
  profile.faults = (scenario, atMs, phase) => ({ ...original(scenario, atMs, phase), hostLost: atMs >= 740 })
  const a = createVehicleSimulationSession(profile, { seconds: 2, neutralTailMs: 1000, scope: { bootId: 101n, sessionId: 201n } })
  const b = createVehicleSimulationSession(createMultirotorProfile(), { seconds: 2, scope: { bootId: 102n, sessionId: 202n } })
  try {
    for (let nowMs = 0; nowMs <= 1840; nowMs += 4) {
      const left = a.step(nowMs), right = b.step(nowMs)
      if (nowMs >= 844) {
        expect(left.phase).toBe('independent-tail')
        expect(left.hostAvailable).toBe(false)
        expect(left.policyAtMs).toBe(720)
        expect(left.board.actuators).toEqual([0, 0, 0, 0])
      }
      if (nowMs === 1840) {
        expect(left.terminal).toBe(true)
        expect(right.terminal).toBe(false)
        expect(right.hostAvailable).toBe(true)
        expect(right.policyAtMs).toBe(1840)
        expect(right.authority.state).toBe('autonomous')
        expect(right.board.actuators.some(n => n > 0)).toBe(true)
      }
    }
    const run = a.result()
    expect(run.status).toBe('host-lost')
    expect(run.board.fault).toBe('output-lease-expired')
    expect(run.path.at(-1)!.atMs).toBe(720)
    expect(run.path.at(-1)!.measurement!.reference.startsWith('101:')).toBe(true)
    expect(() => a.step(1844)).toThrow('closed')
  }
  finally { a.close(); b.close() }
})

test('vehicle sessions reject invalid scope before allocation and invalid epochs without advancing state', () => {
  const profile = createMultirotorProfile()
  let opened = false, getterCalled = false
  profile.createSession = () => { opened = true; throw new Error('Unexpected allocation') }
  for (const scope of [null, { bootId: 0n, sessionId: 1n }, { bootId: 1n, sessionId: 0x10000000000000000n }, { bootId: 1, sessionId: 2n }, { get bootId() { getterCalled = true; return 1n }, sessionId: 2n }]) {
    expect(() => createVehicleSimulationSession(profile, { scope: scope as never })).toThrow('scope')
  }
  expect(opened).toBe(false)
  expect(getterCalled).toBe(false)
  const scope = { bootId: 101n, sessionId: 201n }, session = createVehicleSimulationSession(createMultirotorProfile(), { seconds: 2, scope })
  scope.bootId = 999n; scope.sessionId = 999n
  try {
    expect(() => session.step(4)).toThrow('next 4 ms epoch')
    expect(session.step(0).board.bootId).toBe(101n)
    expect(() => session.step(0)).toThrow('next 4 ms epoch')
    expect(() => session.step(8)).toThrow('next 4 ms epoch')
    expect(session.step(4).atMs).toBe(4)
  }
  finally { session.close() }
  const result = session.result()
  expect(result.status).toBe('blocked')
  expect(result.fault).toBe('simulation-session-closed')
  result.board.actuators[0] = 99
  expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
})

test('a step failure and explicit close both release payload ownership once and revoke the board', () => {
  for (const fail of [false, true]) {
    const profile = createMultirotorProfile(), create = profile.createSession
    let closes = 0
    profile.createSession = () => {
      const base = create()
      return { ...base, renderMeasurement(...args) { if (fail && args[1] === 1000) throw new Error('Captured renderer failure'); return base.renderMeasurement(...args) },
        createPayload: () => ({ request() {}, poll() { return null }, close() { closes++ } }),
      }
    }
    const session = createVehicleSimulationSession(profile, { seconds: 2 })
    try {
      for (let nowMs = 0; nowMs < 1000; nowMs += 4) session.step(nowMs)
      if (fail) expect(() => session.step(1000)).toThrow('Captured renderer failure')
    }
    finally { session.close(); session.close() }
    expect(closes).toBe(1)
    expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
    expect(session.result().board.expiresAtMs).toBeNull()
    expect(session.result().fault).toBe(fail ? 'simulation-step-failed' : 'simulation-session-closed')
    expect(() => session.step(1004)).toThrow('closed')
  }
})

test('a simultaneous step and teardown failure is retained after the independent board is revoked', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let closes = 0
  profile.createSession = () => {
    const base = create()
    return { ...base, renderMeasurement(...args) { if (args[1] === 1000) throw new Error('Renderer failed'); return base.renderMeasurement(...args) },
      createPayload: () => ({ request() {}, poll() { return null }, close() { closes++; throw new Error('Payload teardown failed') } }),
    }
  }
  const session = createVehicleSimulationSession(profile, { seconds: 2 })
  for (let atMs = 0; atMs < 1000; atMs += 4) session.step(atMs)
  let failure: unknown
  try { session.step(1000) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors.map(error => error.message)).toEqual(['Renderer failed', 'Payload teardown failed'])
  session.close()
  expect(closes).toBe(1)
  expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
  expect(session.result().board.expiresAtMs).toBeNull()
})

test('a controller callback cannot reopen the board lease after closing its own session', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession>, returnedNonzero = false
  profile.createSession = () => {
    const base = create()
    return { ...base, createController() {
      const controller = base.createController()
      return { step(context) {
        const output = controller.step(context)
        if (context.nowMs === 1000) { returnedNonzero = output.actuators.some(n => n > 0); session.close() }
        return output
      } }
    } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs < 1000; atMs += 4) session.step(atMs)
    const tick = session.step(1000)
    expect(returnedNonzero).toBe(true)
    expect(tick.terminal).toBe(true)
    expect(tick.hostAvailable).toBe(false)
    expect(tick.policyAtMs).toBe(980)
    expect(tick.board.actuators).toEqual([0, 0, 0, 0])
    expect(tick.board.expiresAtMs).toBeNull()
    expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
    expect(session.result().fault).toBe('simulation-session-closed')
  }
  finally { session.close() }
})

test('a controller cannot recursively advance the same in-flight session epoch', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession>, attempted = false
  profile.createSession = () => {
    const base = create()
    return { ...base, createController() {
      const controller = base.createController()
      return { step(context) {
        if (context.nowMs === 1000 && !attempted) {
          attempted = true
          expect(() => session.step(1000)).toThrow('already stepping')
        }
        return controller.step(context)
      } }
    } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs <= 1000; atMs += 4) session.step(atMs)
    expect(attempted).toBe(true)
    expect(session.step(1004).atMs).toBe(1004)
  }
  finally { session.close() }
})

test('closing from a payload observation prevents later polling and controller work in the same epoch', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession>, closes = 0, workAfterClose = 0
  profile.createSession = () => {
    const base = create()
    return { ...base, createController() {
      const controller = base.createController()
      return { step(context) { if (closes) workAfterClose++; return controller.step(context) } }
    }, createPayload: () => ({
      observe(context) { if (context.nowMs === 1000) session.close() },
      request() { if (closes) workAfterClose++ },
      poll() { if (closes) workAfterClose++; return null },
      close() { closes++ },
    }) }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs < 1000; atMs += 4) session.step(atMs)
    const tick = session.step(1000)
    expect(tick.terminal).toBe(true)
    expect(tick.policyAtMs).toBe(980)
    expect(tick.hostAvailable).toBe(false)
    expect(workAfterClose).toBe(0)
    expect(closes).toBe(1)
    expect(tick.board.actuators).toEqual([0, 0, 0, 0])
    expect(tick.board.expiresAtMs).toBeNull()
  }
  finally { session.close() }
})

test('a closing link callback failure is surfaced without calling the closed payload', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession>, closes = 0, observationsAfterClose = 0
  profile.createSession = () => ({ ...create(),
    linkObservation(nowMs) {
      if (nowMs === 1000) { session.close(); throw new Error('Link callback failed after close') }
      return { capturedAtMs: nowMs, connected: true }
    },
    createPayload: () => ({ observe() { if (closes) observationsAfterClose++ }, request() {}, poll() { return null }, close() { closes++ } }),
  })
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs < 1000; atMs += 4) session.step(atMs)
    expect(() => session.step(1000)).toThrow('Link callback failed after close')
    expect(observationsAfterClose).toBe(0)
    expect(closes).toBe(1)
    expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
  }
  finally { session.close() }
})

test('a returned actuator getter cannot reopen output when capture closes its session', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession>, getterCalled = false
  profile.createSession = () => {
    const base = create()
    return { ...base, createController() {
      const controller = base.createController()
      return { step(context) {
        const output = controller.step(context)
        if (context.nowMs === 1000) {
          const actuators = [...output.actuators]
          Object.defineProperty(output, 'actuators', { enumerable: true, get() { getterCalled = true; session.close(); return actuators } })
        }
        return output
      } }
    } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs < 1000; atMs += 4) session.step(atMs)
    const tick = session.step(1000)
    expect(getterCalled).toBe(true)
    expect(tick.terminal).toBe(true)
    expect(tick.board.actuators).toEqual([0, 0, 0, 0])
    expect(tick.board.expiresAtMs).toBeNull()
    expect(tick.policyAtMs).toBe(980)
  }
  finally { session.close() }
})

test('a returned ACK getter cannot confirm payload work after closing its session', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  profile.mission.tasks = [{ id: 'start', kind: 'start', next: 'capture' }, { id: 'capture', kind: 'payload', operation: 'camera-still', containerId: null, timeoutMs: 1500, next: 'depart' }, ...profile.mission.tasks.filter(task => task.kind !== 'start')]
  let session: ReturnType<typeof createVehicleSimulationSession>, pending: VehiclePayloadCommand | null = null, getterCalled = false
  profile.createSession = () => ({ ...create(), createPayload: () => ({
    request(command) { pending = structuredClone(command) },
    poll(nowMs) {
      if (!pending || nowMs <= pending.issuedAtMs) return null
      const command = pending
      return { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, reference: command.reference,
        capturedAtMs: nowMs, outcome: 'confirmed', metadata: {}, get positionM(): SensorVector { getterCalled = true; session.close(); return [...command.positionM] } }
    },
    close() { pending = null },
  }) })
  session = createVehicleSimulationSession(profile, { seconds: 12 })
  try {
    for (let atMs = 0; ; atMs += 4) { if (session.step(atMs).terminal) break }
    expect(getterCalled).toBe(true)
    expect(session.result().trace.rows.some(row => row.result.reason === 'payload-confirmed')).toBe(false)
    expect(session.result().fault).toBe('simulation-session-closed')
    expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
  }
  finally { session.close() }
})

test('a returned fault getter cannot advance the physical plant after closing its session', () => {
  const profile = createMultirotorProfile(), create = profile.createSession, faults = profile.faults
  let session: ReturnType<typeof createVehicleSimulationSession>, closed = false, stepsAfterClose = 0, getterCalled = false
  profile.faults = (scenario, atMs, phase) => atMs !== 1000 ? faults(scenario, atMs, phase) : {
    get windMps(): SensorVector { getterCalled = true; closed = true; session.close(); return [0, 0, 0] },
  }
  profile.createSession = () => {
    const base = create()
    return { ...base, createPlant() {
      const plant = base.createPlant()
      return { snapshot: plant.snapshot, step(...args) { if (closed) stepsAfterClose++; return plant.step(...args) } }
    } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs <= 1000; atMs += 4) session.step(atMs)
    expect(getterCalled).toBe(true)
    expect(stepsAfterClose).toBe(0)
    expect(session.result().fault).toBe('simulation-session-closed')
    expect(session.result().board.actuators).toEqual([0, 0, 0, 0])
  }
  finally { session.close() }
})

test('the initial plant snapshot is captured before a live session can close through its getters', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession> | undefined, readsAfterExposure = 0, callbacksAfterClose = 0, closed = false
  profile.createSession = () => {
    const base = create()
    return { ...base, createPlant() {
      const plant = base.createPlant()
      return { step: plant.step, snapshot() {
        const state = plant.snapshot()
        return { ...state, get details() { if (session) { readsAfterExposure++; closed = true; session.close() } return state.details } }
      } }
    }, observeIndependent() { if (closed) callbacksAfterClose++ } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs <= 1000; atMs += 4) { if (session.step(atMs).terminal) break }
    expect(readsAfterExposure).toBe(0)
    expect(callbacksAfterClose).toBe(0)
    expect(() => session!.result()).toThrow('still active')
  }
  finally { session.close() }
})

test('adapter methods are bound before exposure so method getters cannot close then invoke work', () => {
  const profile = createMultirotorProfile(), create = profile.createSession
  let session: ReturnType<typeof createVehicleSimulationSession> | undefined, readsAfterExposure = 0, callbacksAfterClose = 0, closed = false
  profile.createSession = () => {
    const base = create()
    return { ...base, createController() {
      const controller = base.createController()
      return { get step() {
        if (session) { readsAfterExposure++; closed = true; session.close() }
        return (context: Parameters<typeof controller.step>[0]) => { if (closed) callbacksAfterClose++; return controller.step(context) }
      } }
    } }
  }
  session = createVehicleSimulationSession(profile, { seconds: 2 })
  try {
    for (let atMs = 0; atMs <= 1000; atMs += 4) { if (session.step(atMs).terminal) break }
    expect(readsAfterExposure).toBe(0)
    expect(callbacksAfterClose).toBe(0)
    expect(() => session!.result()).toThrow('still active')
  }
  finally { session.close() }
})
