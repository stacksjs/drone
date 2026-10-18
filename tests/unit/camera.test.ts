import type { CameraFrame } from '../../resources/functions/drone/camera/types'
import type { CameraSourceCallbacks } from '../../resources/functions/drone/camera/imx500'
import { describe, expect, test } from 'bun:test'
import { createVisualTracker } from '../../resources/functions/drone/camera/tracker'
import { parseCameraPacket } from '../../resources/functions/drone/camera/protocol'
import { createCameraSession } from '../../resources/functions/drone/camera/session'
import { applyCameraCommand, authorizeCamera, cameraCommand } from '../../resources/functions/drone/camera/http'
import { createVisualLockGuard } from '../../resources/functions/drone/camera/guard'

const person = (x = 0.2, confidence = 0.95) => ({ label: 'person' as const, confidence, box: { x, y: 0.2, width: 0.2, height: 0.6 } })
const frame = (sequence: number, time = sequence * 100, detections = [person()]): CameraFrame => ({ sequence, capturedAtMs: time, receivedAtMs: time, detections })
function selected() {
  const tracker = createVisualTracker()
  tracker.update(frame(1), 100)
  tracker.select('1:0', 1, 100)
  return tracker
}

describe('explicit visual selection', () => {
  test('detections never select a target automatically', () => {
    const tracker = createVisualTracker()
    const snapshot = tracker.update(frame(1), 100)
    expect(snapshot.state).toBe('idle')
    expect(snapshot.selected).toBeNull()
    expect(snapshot.observation).toBeNull()
  })
  test('confirms continuity before supplying an image observation', () => {
    const tracker = selected()
    expect(tracker.snapshot(100).confirmed).toBe(false)
    expect(tracker.update(frame(2), 200).confirmed).toBe(false)
    const snapshot = tracker.update(frame(3), 300)
    expect(snapshot.confirmed).toBe(true)
    expect(snapshot.observation?.horizontalError).toBeCloseTo(-0.4)
    expect(snapshot.selected?.id).toMatch(/^[\da-f-]{36}:1$/)
  })
  test('a displayed recent frame can be selected after newer frames arrive', () => {
    const tracker = createVisualTracker()
    tracker.update(frame(1), 100)
    tracker.update(frame(2), 200)
    tracker.update(frame(3), 300)
    expect(tracker.select('1:0', 1, 300).confirmed).toBe(true)
  })
  test('lost targets never auto-reacquire, including when a person returns', () => {
    const tracker = selected()
    const original = tracker.snapshot(100).selected!.id
    expect(tracker.update(frame(2, 200, []), 200).state).toBe('lost')
    expect(tracker.update(frame(3), 300).state).toBe('lost')
    expect(tracker.select('3:0', 3, 300).selected?.id).not.toBe(original)
  })
  test('ambiguous overlapping people invalidate the lock', () => {
    const tracker = selected()
    const snapshot = tracker.update(frame(2, 200, [person(0.2), person(0.23)]), 200)
    expect(snapshot.state).toBe('lost')
    expect(snapshot.reason).toContain('Ambiguous')
    expect(snapshot.observation).toBeNull()
  })
  test('empty and low-confidence inference are real losses', () => {
    for (const detections of [[], [person(0.2, 0.3)]]) {
      const tracker = selected()
      expect(tracker.update(frame(2, 200, detections), 200).state).toBe('lost')
    }
  })
  test('camera stalls lose the lock even without another frame', () => {
    const tracker = selected()
    expect(tracker.snapshot(601).state).toBe('lost')
    expect(tracker.snapshot(601).candidates).toEqual([])
    expect(() => tracker.select('1:0', 1, 601)).toThrow()
  })
  test('replayed sequence numbers do not refresh a lock', () => {
    const tracker = selected()
    tracker.update(frame(1, 500), 500)
    expect(tracker.snapshot(601).state).toBe('lost')
  })
  test('delayed and future frames cannot become observations', () => {
    for (const invalid of [{ ...frame(2), capturedAtMs: -1000 }, { ...frame(2), capturedAtMs: 201 }]) {
      const tracker = selected()
      expect(tracker.update(invalid, 200).state).toBe('lost')
    }
  })
  test('invalid boxes fail closed and snapshots cannot mutate tracker state', () => {
    const tracker = selected()
    const copy = tracker.snapshot(100)
    copy.selected!.box.x = 0.8
    expect(tracker.snapshot(100).selected?.box.x).toBe(0.2)
    const invalid = frame(2)
    invalid.detections[0]!.box.width = Infinity
    expect(tracker.update(invalid, 200).state).toBe('lost')
    expect(() => tracker.select('1:0', 1, 200)).toThrow()
  })
  test('clock reversal and source failure invalidate selection', () => {
    const tracker = selected()
    expect(tracker.snapshot(99).state).toBe('lost')
    tracker.fail('Worker exited')
    expect(() => tracker.select('1:0', 1, 100)).toThrow()
  })
  test('invalid configuration is rejected', () => {
    expect(() => createVisualTracker({ maxAgeMs: Infinity })).toThrow()
    expect(() => createVisualTracker({ confirmations: 1 })).toThrow()
  })
})

describe('hardware packet freshness', () => {
  const packet = () => ({ version: 1, sequence: 1, capturedMonotonicMs: 9900, detections: [person()] })
  test('accounts for queue delay when converting worker time', () => {
    const parsed = parseCameraPacket(packet(), 100, 10000)
    expect(parsed.frame.capturedAtMs).toBe(0)
    expect(parsed.frame.receivedAtMs).toBe(100)
    expect(parsed.image).toBeNull()
  })
  test('rejects old, future, malformed and oversize worker results', () => {
    for (const bad of [{ ...packet(), capturedMonotonicMs: 9000 }, { ...packet(), capturedMonotonicMs: 10001 }, { ...packet(), version: 2 }, { ...packet(), jpeg: 'https://example.com/image.jpg' }, { ...packet(), sequence: NaN }])
      expect(() => parseCameraPacket(bad, 100, 10000)).toThrow()
  })
})

describe('session lifecycle and operator API', () => {
  test('source errors and late callbacks cannot revive a stopped session', () => {
    let callbacks: CameraSourceCallbacks | undefined
    let now = 100
    let closed = false
    const session = createCameraSession({ now: () => now, liveSource: input => { callbacks = input; return { close() { closed = true } } } })
    expect(session.start('imx500').status).toBe('starting')
    callbacks!.onFrame(frame(1), null)
    const current = session.snapshot()
    session.select('1:0', 1, current.sessionId!)
    callbacks!.onError('camera disconnected')
    expect(session.snapshot().tracking.state).toBe('lost')
    expect(session.snapshot().status).toBe('error')
    session.stop()
    now = 200
    callbacks!.onFrame(frame(2), null)
    expect(session.snapshot().status).toBe('stopped')
    expect(closed).toBe(true)
  })
  test('a worker failure never becomes a fake successful source', () => {
    const session = createCameraSession({ liveSource: () => { throw new Error('no hardware') } })
    expect(session.start('imx500').status).toBe('error')
    expect(() => session.start('replay')).toThrow('Stop')
    session.stop()
  })
  test('selection tokens are bound to the current session epoch', () => {
    const session = createCameraSession()
    const first = session.start('replay')
    session.stop()
    const second = session.start('replay')
    try {
      expect(second.sessionId).not.toBe(first.sessionId)
      expect(() => session.select('1:0', 1, first.sessionId!)).toThrow('session changed')
    }
    finally { session.stop() }
  })
  test('a guard cannot accept a new lock after camera restart', () => {
    let callbacks: CameraSourceCallbacks | undefined
    let now = 100
    const session = createCameraSession({ now: () => now, liveSource: input => { callbacks = input; return { close() {} } } })
    function lock() {
      const started = session.start('imx500')
      callbacks!.onFrame(frame(1, now), null)
      session.select('1:0', 1, started.sessionId!)
      callbacks!.onFrame(frame(2, ++now), null)
      callbacks!.onFrame(frame(3, ++now), null)
      return session.snapshot().tracking.selected!.id
    }
    const first = lock()
    const guard = createVisualLockGuard({ selectedLockId: first, read: () => session.snapshot().tracking })
    expect(guard(now)).toBeUndefined()
    session.stop()
    now += 100
    try {
      expect(lock()).not.toBe(first)
      expect(guard(now)).toContain('changed')
    }
    finally { session.stop() }
  })
  test('camera initialization preserves default signal termination', async () => {
    const child = Bun.spawn([process.execPath, '-e', `import { cameraSession } from './resources/functions/drone/camera/session'; cameraSession(); Bun.serve({ port: 0, fetch: () => new Response('ok') }); console.log('ready')`], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    try {
      const reader = child.stdout.getReader()
      await reader.read()
      reader.releaseLock()
      child.kill('SIGTERM')
      const exit = await Promise.race([child.exited.then(() => 'exited'), Bun.sleep(1000).then(() => 'alive')])
      expect(exit).toBe('exited')
    }
    finally { if (child.exitCode === null) child.kill('SIGKILL') }
  })
  test('command authorization precedes bounded wire parsing', async () => {
    const previous = process.env.DRONE_CAMERA_TOKEN
    const secret = 'camera-test-secret-for-wire-limit'.repeat(2)
    process.env.DRONE_CAMERA_TOKEN = secret
    const request = (body: string, authorized = true) => new Request('http://localhost/api/camera/command', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${secret}` } : {}) }, body })
    try {
      const unauthorized = request(' '.repeat(1000000) + '{}', false)
      expect((await cameraCommand(unauthorized)).status).toBe(401)
      expect(unauthorized.bodyUsed).toBe(false)
      expect((await cameraCommand(request(' '.repeat(1000000) + '{"command":"stop"}'))).status).toBe(413)
      expect((await cameraCommand(request('{'))).status).toBe(400)
      expect((await cameraCommand(request('{"command":"stop"}'))).status).toBe(200)
    }
    finally {
      if (previous === undefined) delete process.env.DRONE_CAMERA_TOKEN
      else process.env.DRONE_CAMERA_TOKEN = previous
    }
  })
  test('operator commands reject arbitrary sources and paths', () => {
    const session = createCameraSession()
    expect(() => applyCameraCommand({ command: 'start', source: '/tmp/script' }, session)).toThrow()
    expect(() => applyCameraCommand({ command: 'select', candidateId: 3 }, session)).toThrow()
    expect(() => applyCameraCommand({ command: 'inject', fault: 'loss' }, session)).toThrow()
  })
  test('bearer auth is mandatory even in local development', () => {
    const secret = 'a'.repeat(64)
    expect(authorizeCamera({ headers: new Headers() }, secret)?.status).toBe(401)
    expect(authorizeCamera({ headers: new Headers({ cookie: `token=${secret}` }) }, secret)?.status).toBe(401)
    expect(authorizeCamera({ headers: new Headers({ Authorization: `Bearer ${secret}` }) }, secret)).toBeUndefined()
    expect(authorizeCamera({ headers: new Headers() }, '')?.status).toBe(503)
    expect(authorizeCamera({ headers: new Headers({ Authorization: `Bearer ${'é'.repeat(64)}` }) }, secret)?.status).toBe(401)
  })
  test('replay loss and recovery require explicit reselection', async () => {
    const session = createCameraSession()
    const initial = session.start('replay')
    try {
      session.select('1:0', 1, initial.sessionId!)
      await Bun.sleep(220)
      expect(session.snapshot().tracking.confirmed).toBe(true)
      session.inject('loss')
      await Bun.sleep(120)
      expect(session.snapshot().tracking.state).toBe('lost')
      session.inject('none')
      await Bun.sleep(120)
      expect(session.snapshot().tracking.state).toBe('lost')
    }
    finally { session.stop() }
  })
})

test('a visual loss or reselection holds a metric controller without fabricating a position', async () => {
  const { createController, createSimulator, follow, createVisualLockGuard } = await import('../../resources/functions/drone')
  const tracker = selected()
  tracker.update(frame(2), 200)
  const lock = tracker.update(frame(3), 300)
  const sim = createSimulator()
  const controller = createController(sim.adapter, follow({ distanceMeters: 10, altitudeMeters: 12, gain: 0.5 }), {
    targetId: 'gps-pilot', guard: createVisualLockGuard({ selectedLockId: lock.selected!.id, read: now => tracker.snapshot(now) }),
  })
  controller.setTarget({ id: 'gps-pilot', position: { north: 5, east: 0, down: 0 }, headingRadians: 0, confidence: 1, accuracyMeters: 1, receivedAtMs: 300 })
  controller.enable(300, 500)
  expect(controller.tick(300).kind).toBe('velocity')
  tracker.update(frame(4, 400, []), 400)
  expect(controller.tick(400).kind).toBe('hold')
  tracker.update(frame(5), 500)
  tracker.select('5:0', 5, 500)
  expect(controller.tick(500).kind).toBe('hold')
  controller.close()
})
