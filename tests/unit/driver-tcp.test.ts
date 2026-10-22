import type { Socket } from 'node:net'
import type { TcpAdapter } from '../../resources/functions/drone/drivers'
import { createServer } from 'node:net'
import { expect, test } from 'bun:test'
import { createArduPilotDriver, createPx4Driver } from '../../resources/functions/drone/drivers'
import { createMavlinkStreamDecoder, encodeFrame, encodeFrameV2 } from '../../resources/functions/drone/mavlink'
import { runDriverProtocolBench } from '../../resources/functions/drone/drivers/bench'
import vectors from '../fixtures/drivers/wire.json'
import telemetryVectors from '../fixtures/mavlink.json'
import { createPressurePeer } from '../fixtures/drivers/pressure'

async function until(condition: () => boolean) {
  const deadline = performance.now() + 1500
  while (!condition()) { if (performance.now() > deadline) throw new Error('TCP peer observation timed out'); await Bun.sleep(5) }
}
async function peer() {
  const sockets: Socket[] = [], received: Buffer[] = [], receivedByConnection: Buffer[][] = []
  const server = createServer(socket => { sockets.push(socket); const own: Buffer[] = []; receivedByConnection.push(own); socket.on('data', data => { const bytes = typeof data === 'string' ? Buffer.from(data) : data; received.push(bytes); own.push(bytes) }); socket.on('error', () => {}) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TCP peer port')
  return { port: address.port, sockets, received, receivedByConnection, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
function telemetry(autopilot: number) {
  const heartbeat = new Uint8Array(9); new DataView(heartbeat.buffer).setUint32(0, autopilot === 12 ? 6 << 16 : 4, true); heartbeat.set([2, autopilot, 128, 4, 3], 4)
  const battery = new Uint8Array(31); battery[30] = 90
  const position = new Uint8Array(28); new DataView(position.buffer).setFloat32(12, -12, true)
  return Buffer.concat([encodeFrame(0, heartbeat, 0, 1, 1), encodeFrame(1, battery, 1, 1, 1), encodeFrame(32, position, 2, 1, 1)])
}

test('both TCP driver factories assemble fragmented telemetry and never write in physical mode', async () => {
  for (const [factory, autopilot] of [[createArduPilotDriver, 3], [createPx4Driver, 12]] as const) {
    const remote = await peer()
    let driver: Awaited<ReturnType<typeof factory>> | undefined
    try {
      const options = { transport: 'tcp' as const, kind: 'telemetry-only' as 'sitl' | 'telemetry-only', port: remote.port }
      driver = await factory(options)
      options.kind = 'sitl'
      await until(() => remote.sockets.length === 1)
      const bytes = telemetry(autopilot)
      remote.sockets[0]!.write(bytes.subarray(0, 2))
      await Bun.sleep(20)
      expect(driver.read()?.batteryPercent).toBe(-1)
      remote.sockets[0]!.write(bytes.subarray(2))
      await until(() => driver!.read()?.batteryPercent === 90)
      expect(driver.read()?.position.down).toBe(-12)
      expect(driver.read()?.positionHealthy).toBe(false)
      driver.send({ kind: 'hold', reason: 'receive-only' })
      await expect(driver.protocol.sendCommand(400, [1])).rejects.toHaveProperty('code', 'read-only')
      await Bun.sleep(30)
      expect(remote.received).toHaveLength(0)
    }
    finally { driver?.close(); await remote.close() }
  }
})

test('the TCP protocol bench completes discovery, retry, parameters and mission resume', async () => {
  const result = await runDriverProtocolBench({ driver: 'px4', transport: 'tcp', signed: true, dropFirstAck: true })
  expect(result.transport).toBe('tcp')
  expect(result.confirmations).toEqual([0, 1])
  expect(result.parameterAfter.value).toBe(43)
  expect(result.downloaded).toHaveLength(2)
  expect(result.resume).toEqual({ index: 1, accepted: true, executionConfirmed: false })
  expect(result.physicalFlightEnabled).toBe(false)
})

for (const driver of ['ardupilot', 'px4'] as const) {
  for (const signed of [false, true]) {
    test(`TCP ${driver} ${signed ? 'signed' : 'unsigned'} round trip reports its actual transport`, async () => {
      const result = await runDriverProtocolBench({ driver, transport: 'tcp', signed, dropFirstAck: true })
      expect(result.transport).toBe('tcp')
      expect(result.capabilities.driver).toBe(driver)
      expect(result.confirmations).toEqual([0, 1])
      expect(result.parameterBefore.value).toBe(42)
      expect(result.parameterAfter.value).toBe(43)
      expect(result.uploaded.count).toBe(2)
      expect(result.downloaded.map(item => item.latitudeDeg)).toEqual([0.001, 0.003])
      expect(result.resume.executionConfirmed).toBe(false)
      expect(result.hardwareValidated).toBe(false)
    })
  }
}

async function discover(remote: Awaited<ReturnType<typeof peer>>, driver: Awaited<ReturnType<typeof createArduPilotDriver>>, index = 0) {
  const connection = remote.sockets[index]!
  connection.write(telemetry(driver.driver === 'ardupilot' ? 3 : 12))
  await until(() => Number.isFinite(driver.protocol.snapshot().lastHeartbeatAtMs))
  const received = createMavlinkStreamDecoder()
  let requested = false
  const listener = (bytes: Buffer | string) => { if (typeof bytes === 'string') throw new Error('Expected native bytes'); for (const frame of received.push(bytes)) if (frame.id === 76) requested = true }
  connection.on('data', listener)
  const result = driver.protocol.discover()
  try {
    await until(() => requested)
    const ack = new Uint8Array(10); new DataView(ack.buffer).setUint16(0, 512, true); ack.set([245, 191], 8)
    connection.write(Buffer.concat([Buffer.from(vectors.packets.version, 'hex'), encodeFrameV2(77, ack, 1, 1, 1)]))
    await result
  }
  finally { connection.off('data', listener) }
}

test('peer EOF rejects pending work and reconnection starts with fresh framing, capabilities and no resumed request', async () => {
  const remote = await peer()
  let first: Awaited<ReturnType<typeof createArduPilotDriver>> | undefined, second: typeof first
  try {
    first = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => remote.sockets.length === 1)
    await discover(remote, first)
    const pending = first.protocol.sendCommand(511, [32, 200000]).catch(error => error)
    remote.sockets[0]!.write(Buffer.from(telemetryVectors.v2Heartbeat, 'hex').subarray(0, 2)) // An unfinished frame must not cross connections.
    remote.sockets[0]!.end()
    expect((await pending).code).toBe('transport-lost')
    expect(first.read()).toBeUndefined()
    expect(first.protocol.snapshot().active).toBeNull()
    second = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => remote.sockets.length === 2)
    remote.sockets[1]!.write(Buffer.from(telemetryVectors.v2Heartbeat, 'hex').subarray(2))
    await Bun.sleep(30)
    expect(second.protocol.snapshot().capabilities).toBeNull()
    expect(second.protocol.snapshot().lastHeartbeatAtMs).toBe(-Infinity)
    expect(remote.receivedByConnection[1]).toHaveLength(0)
    await expect(second.protocol.sendCommand(511)).rejects.toHaveProperty('code', 'unavailable')
    await discover(remote, second, 1)
    expect(second.protocol.snapshot().quarantined).toEqual([])
    expect(second.protocol.snapshot().active).toBeNull()
    await expect(first.protocol.sendCommand(512)).rejects.toHaveProperty('code', 'transport-lost')
    first.close(); first.close()
  }
  finally { first?.close(); second?.close(); await remote.close() }
})

test('PX4 TCP setpoints require deliberate fresh priming and release stops the stream', async () => {
  const remote = await peer()
  let now = 0
  const driver = await createPx4Driver({ transport: 'tcp', kind: 'sitl', port: remote.port, now: () => now })
  try {
    await until(() => remote.sockets.length === 1)
    expect(driver.primeOffboard().ready).toBe(false)
    for (let step = 0; step <= 8; step++) {
      now = step * 200
      remote.sockets[0]!.write(telemetry(12))
      await until(() => driver.read()?.receivedAtMs === now)
      if (step === 0) {
        driver.send({ kind: 'hold', reason: 'unprimed' })
        await Bun.sleep(10)
        expect(remote.received).toHaveLength(0)
      }
      expect(driver.primeOffboard().ready).toBe(step === 8)
    }
    driver.send({ kind: 'velocity', velocity: { north: 1, east: 0, down: 0 }, reason: 'primed' })
    const frames = () => createMavlinkStreamDecoder().push(Buffer.concat(remote.received))
    await until(() => frames().length === 10)
    expect(frames().every(frame => frame.id === 84)).toBe(true)
    expect(new DataView(frames().at(-1)!.payload.buffer).getFloat32(16, true)).toBe(1)
    driver.send({ kind: 'release', reason: 'release' })
    await Bun.sleep(20)
    expect(frames()).toHaveLength(10)
  }
  finally { driver.close(); await remote.close() }
})

test('TCP refuses invalid destinations and an actual closed listener without retaining a session', async () => {
  for (const port of [0, -1, 65536, NaN]) await expect(createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port })).rejects.toThrow('TCP port')
  const remote = await peer(), port = remote.port
  await remote.close()
  await expect(createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port })).rejects.toThrow()
})

test('terminal peer loss stops polling before a caller explicitly closes the failed adapter', async () => {
  const remote = await peer()
  let clockReads = 0
  const driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port, now: () => { clockReads++; return performance.now() } })
  try {
    await until(() => remote.sockets.length === 1)
    remote.sockets[0]!.write(telemetry(3))
    await until(() => Number.isFinite(driver.read()?.receivedAtMs))
    remote.sockets[0]!.end()
    await until(() => driver.protocol.snapshot().fault !== null)
    const readsAtFailure = clockReads
    await Bun.sleep(100)
    expect(clockReads).toBe(readsAtFailure)
    expect(driver.read()).toBeUndefined()
  }
  finally { driver.close(); await remote.close() }
})

test('outstanding writes to a real paused TCP peer are bounded without replaying a buffered setpoint', async () => {
  const remote = await peer()
  const driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
  try {
    await until(() => remote.sockets.length === 1)
    remote.sockets[0]!.write(telemetry(3))
    await until(() => Number.isFinite(driver.read()?.receivedAtMs))
    remote.sockets[0]!.pause()
    expect(remote.sockets[0]!.readableFlowing).toBe(false)
    let attempted = 0
    while (!driver.protocol.snapshot().fault && attempted < 200_000) { driver.send({ kind: 'hold', reason: 'paused-reader-boundary' }); attempted++ }
    expect(driver.protocol.snapshot().fault).toContain('backpressured')
    expect(attempted).toBeLessThan(200_000)
    expect(driver.read()).toBeUndefined()
    driver.send({ kind: 'velocity', velocity: { north: 1, east: 0, down: 0 }, reason: 'failed transport' })
    await expect(driver.protocol.sendCommand(511)).rejects.toHaveProperty('code', 'transport-lost')
  }
  finally { driver.close(); await remote.close() }
})

test('wrong firmware identity cannot establish a TCP session and silent startup expires', async () => {
  const remote = await peer()
  const driver = await createPx4Driver({ transport: 'tcp', kind: 'telemetry-only', port: remote.port })
  try {
    await until(() => remote.sockets.length === 1)
    remote.sockets[0]!.write(telemetry(3))
    await Bun.sleep(30)
    expect(driver.protocol.snapshot().lastHeartbeatAtMs).toBe(-Infinity)
    expect(driver.read()?.batteryPercent).toBe(-1)
    const deadline = performance.now() + 2500
    while (!driver.protocol.snapshot().fault) { if (performance.now() > deadline) throw new Error('TCP initial heartbeat deadline did not settle'); await Bun.sleep(10) }
    expect(driver.protocol.snapshot().fault).toContain('matching heartbeat deadline')
    expect(driver.read()).toBeUndefined()
    expect(remote.received).toHaveLength(0)
  }
  finally { driver.close(); await remote.close() }
})

// Public factory deadline seam: actual loopback setup plus a real event-loop pause.
// This catches late callback admission, not network SYN loss or physical timing.
test('a native connect callback after the absolute setup deadline cannot establish a TCP adapter', async () => {
  const sockets = new Set<Bun.Socket<undefined>>()
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
    open(socket) { sockets.add(socket) },
    data() {},
    close(socket) { sockets.delete(socket) },
  } })
  let driver: Awaited<ReturnType<typeof createArduPilotDriver>> | undefined
  try {
    const pending = createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: server.port })
      .then(adapter => { driver = adapter; return undefined }, (error: unknown) => error)
    const started = performance.now()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200)
    expect(performance.now() - started).toBeGreaterThanOrEqual(2000)
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('An expired native connect established an adapter')
    expect(error.message).toContain('TCP connection deadline expired')
    await until(() => sockets.size === 0)
  }
  finally { driver?.close(); server.stop(true) }
}, 6000)

async function fillNativeBackpressure(driver: TcpAdapter, sendBudget = 550000, fillDeadline = performance.now() + 10000) {
  let attempted = 0
  while (!driver.transportSnapshot().backpressured && !driver.protocol.snapshot().fault && attempted < sendBudget && performance.now() < fillDeadline) {
    for (let index = 0; index < 128 && attempted < sendBudget && !driver.transportSnapshot().backpressured && !driver.protocol.snapshot().fault; index++) {
      driver.send({ kind: 'hold', reason: 'native drain deadline' }); attempted++
    }
    await Bun.sleep(0)
  }
  return { attempted, blocked: driver.transportSnapshot() }
}

// A native pressure phase may make legitimate progress before its deadline.
// Continue establishment only after observing that transition within its budget.
async function observeNativeOutputExpiry(driver: TcpAdapter, mode: 'drain' | 'progress') {
  const fillDeadline = performance.now() + 10000
  let attempted = 0, phases = 0
  const history: Array<{ before: ReturnType<TcpAdapter['transportSnapshot']>, after: ReturnType<TcpAdapter['transportSnapshot']>, elapsedMs: number, fault: string | null }> = []
  try {
    while (performance.now() < fillDeadline && attempted < 550000) {
      let before = driver.transportSnapshot()
      if (mode === 'drain') {
        const phase = await fillNativeBackpressure(driver, 550000 - attempted, fillDeadline)
        attempted += phase.attempted; before = phase.blocked
      }
      else if (before.pendingCallbackBytes === 0 && !before.backpressured) {
        const phase = await fillNativePendingWrites(driver, 550000 - attempted, fillDeadline)
        attempted += phase.attempted; before = phase.pending
      }
      const epoch = mode === 'drain' ? before.blockedSinceMs : before.lastWriteProgressAtMs
      const ready = mode === 'drain' ? before.backpressured : !before.backpressured && before.pendingCallbackBytes > 0
      if (!ready || before.state !== 'connected' || epoch === null) throw new Error(`Native TCP ${mode} pressure was not established within its byte/time budget`)
      const started = performance.now()
      try {
        // No writes while waiting. A continuous stall keeps the original 1500 ms
        // immediate-failure guard; a valid transition starts a new pressure phase.
        await until(() => {
          if (driver.protocol.snapshot().fault !== null) return true
          const after = driver.transportSnapshot()
          return mode === 'drain' ? !after.backpressured : after.pendingCallbackBytes === 0 || after.lastWriteProgressAtMs !== before.lastWriteProgressAtMs
        })
      }
      finally {
        phases++
        if (history.length === 16) history.shift()
        history.push({ before, after: driver.transportSnapshot(), elapsedMs: performance.now() - started, fault: driver.protocol.snapshot().fault })
      }
      if (driver.protocol.snapshot().fault !== null) return { attempted, pressure: before }
      if (performance.now() - epoch >= 500) throw new Error(`Native TCP ${mode} transition was late or timing-ambiguous; pressure establishment cannot continue`)
    }
    throw new Error(`Native TCP sustained ${mode} pressure was not established within its byte/time budget`)
  }
  finally { console.log(JSON.stringify({ campaign: `native-tcp-${mode}-phases`, attempted, phases, retainedPhaseLimit: 16, history })) }
}

test('native TCP backpressure expires the drain deadline without an additional write', async () => {
  const remote = await createPressurePeer(telemetry(3))
  let driver: TcpAdapter | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => driver!.read()?.batteryPercent === 90)
    const { attempted, pressure: blocked } = await observeNativeOutputExpiry(driver, 'drain')
    console.log(JSON.stringify({ campaign: 'native-tcp-drain', attempted, blocked, receivedBytes: remote.receivedBytes(), fault: driver.protocol.snapshot().fault }))
    expect(blocked.backpressured).toBe(true)
    expect(blocked.state).toBe('connected')
    expect(blocked.pendingCallbackBytes).toBeLessThanOrEqual(16384)
    expect(remote.receivedBytes()).toBe(0)
    expect(driver.protocol.snapshot().fault).toContain('TCP output drain deadline expired')
    expect(performance.now() - blocked.blockedSinceMs!).toBeGreaterThanOrEqual(500)
    expect(driver.read()).toBeUndefined()
    expect(driver.transportSnapshot().state).toBe('failed')
  }
  finally { driver?.close(); await remote.close() }
}, 15000)

test('late native drain callbacks cannot erase an expired output deadline', async () => {
  const remote = await createPressurePeer(telemetry(3))
  let driver: TcpAdapter | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => driver!.read()?.batteryPercent === 90)
    const { attempted, blocked } = await fillNativeBackpressure(driver)
    expect(blocked.backpressured).toBe(true)
    expect(blocked.state).toBe('connected')
    remote.resume()
    expect(driver.transportSnapshot().backpressured).toBe(true)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550)
    await Bun.sleep(25)
    console.log(JSON.stringify({ campaign: 'late-native-tcp-drain', attempted, blocked, after: driver.transportSnapshot(), fault: driver.protocol.snapshot().fault }))
    expect(driver.protocol.snapshot().fault).toContain('TCP output drain deadline expired')
    expect(driver.read()).toBeUndefined()
  }
  finally { driver?.close(); await remote.close() }
}, 15000)

test('a native drain within budget settles accepted bytes once and transport snapshots cannot change the connection', async () => {
  const remote = await createPressurePeer(telemetry(3))
  let driver: TcpAdapter | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => driver!.read()?.batteryPercent === 90)
    const { attempted, blocked } = await fillNativeBackpressure(driver)
    expect(blocked.backpressured).toBe(true)
    expect(blocked.pendingCallbackBytes).toBeGreaterThan(0)
    const detached = driver.transportSnapshot()
    Object.assign(detached, { state: 'closed', backpressured: false, pendingCallbackBytes: 0 })
    expect(driver.transportSnapshot().state).toBe('connected')
    expect(driver.transportSnapshot().backpressured).toBe(true)
    remote.resume()
    // Unsigned SET_POSITION_TARGET_LOCAL_NED is 53 payload bytes plus the 8-byte v1 envelope.
    await until(() => remote.receivedBytes() === attempted * 61 && driver!.transportSnapshot().pendingCallbackBytes === 0)
    expect(driver.transportSnapshot().backpressured).toBe(false)
    expect(driver.protocol.snapshot().fault).toBeNull()
    expect(blocked.backpressured).toBe(true)
    driver.send({ kind: 'hold', reason: 'fresh write after observed native drain' })
    await until(() => remote.receivedBytes() === (attempted + 1) * 61)
    expect(driver.protocol.snapshot().fault).toBeNull()
    driver.close()
    expect(driver.transportSnapshot().state).toBe('closed')
  }
  finally { driver?.close(); await remote.close() }
}, 15000)

async function fillNativePendingWrites(driver: TcpAdapter, sendBudget = 550000, fillDeadline = performance.now() + 10000) {
  let attempted = 0, observedPending = false
  while (!observedPending && !driver.protocol.snapshot().fault && attempted < sendBudget && performance.now() < fillDeadline) {
    for (let index = 0; index < 16 && attempted < sendBudget && !driver.transportSnapshot().backpressured; index++) {
      driver.send({ kind: 'hold', reason: 'native callback progress deadline' }); attempted++
    }
    await Bun.sleep(0)
    if (driver.transportSnapshot().pendingCallbackBytes > 0 && !driver.transportSnapshot().backpressured) {
      await Bun.sleep(25)
      observedPending = driver.transportSnapshot().pendingCallbackBytes > 0 && !driver.transportSnapshot().backpressured
    }
  }
  return { attempted, pending: driver.transportSnapshot(), observedPending }
}

test('native TCP writes below the watermark expire when their callbacks make no progress', async () => {
  const remote = await createPressurePeer(telemetry(3))
  let driver: TcpAdapter | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => driver!.read()?.batteryPercent === 90)
    const { attempted, pressure: pending } = await observeNativeOutputExpiry(driver, 'progress')
    console.log(JSON.stringify({ campaign: 'native-tcp-write-progress', attempted, pending, receivedBytes: remote.receivedBytes(), fault: driver.protocol.snapshot().fault }))
    expect(pending.state).toBe('connected')
    expect(pending.backpressured).toBe(false)
    expect(pending.pendingCallbackBytes).toBeGreaterThan(0)
    expect(pending.runtimeWritableBytes).toBeLessThan(4096)
    expect(remote.receivedBytes()).toBe(0)
    expect(driver.protocol.snapshot().fault).toContain('TCP write progress deadline expired')
    expect(performance.now() - pending.lastWriteProgressAtMs!).toBeGreaterThanOrEqual(500)
    expect(driver.read()).toBeUndefined()
    expect(driver.transportSnapshot().state).toBe('failed')
  }
  finally { driver?.close(); await remote.close() }
}, 15000)

test('late native write callbacks cannot erase an expired below-watermark progress deadline', async () => {
  const remote = await createPressurePeer(telemetry(3))
  let driver: TcpAdapter | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: remote.port })
    await until(() => driver!.read()?.batteryPercent === 90)
    const { attempted, pending, observedPending } = await fillNativePendingWrites(driver)
    expect(observedPending).toBe(true)
    expect(pending.backpressured).toBe(false)
    remote.resume()
    expect(driver.transportSnapshot().pendingCallbackBytes).toBeGreaterThan(0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 550)
    await Bun.sleep(25)
    console.log(JSON.stringify({ campaign: 'late-native-tcp-progress', attempted, pending, after: driver.transportSnapshot(), fault: driver.protocol.snapshot().fault }))
    expect(driver.protocol.snapshot().fault).toContain('TCP write progress deadline expired')
    expect(driver.read()).toBeUndefined()
  }
  finally { driver?.close(); await remote.close() }
}, 15000)

test('a queued initial heartbeat cannot establish telemetry after its absolute matching deadline', async () => {
  let remote: Bun.Socket<undefined> | undefined
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
    open(socket) { remote = socket },
    data() {},
  } })
  let driver: Awaited<ReturnType<typeof createArduPilotDriver>> | undefined
  try {
    driver = await createArduPilotDriver({ transport: 'tcp', kind: 'sitl', port: server.port })
    await until(() => remote !== undefined)
    remote!.write(telemetry(3))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200)
    await Bun.sleep(25)
    expect(driver.protocol.snapshot().fault).toContain('matching heartbeat deadline expired')
    expect(driver.read()).toBeUndefined()
  }
  finally { driver?.close(); server.stop(true) }
}, 6000)
