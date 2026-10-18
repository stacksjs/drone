import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { antennaPointing, unwrapPan } from '../../resources/functions/drone/antenna/geometry'
import { createAntennaTracker } from '../../resources/functions/drone/antenna/tracker'
import { antennaFixtureConfig, antennaFix } from '../fixtures/antenna/context'
import { antennaBenchScenarios, runAntennaBench } from '../../resources/functions/drone/antenna/bench'

// Public function seam: catches reference/sign/wrap errors, not survey or encoder error.
test('surveyed equatorial east chord has analytic elevation and true north calibration', () => {
  const origin = { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 0 }
  const pointing = antennaPointing(origin, { ...origin, longitudeDeg: 0.01 })
  expect(pointing.azimuthDeg).toBeCloseTo(90, 9)
  // Two points on the equator at the same height: elevation = -longitude/2.
  expect(pointing.elevationDeg).toBeCloseTo(-0.005, 7)
  expect(pointing.enuM[0]).toBeGreaterThan(1113)
  expect(pointing.nedM[2]).toBeGreaterThan(0)
  expect(unwrapPan(1, 359)).toBe(361)
  expect(unwrapPan(359, 1)).toBe(-1)
})

// Public controller seam: catches authority, freshness and trajectory errors, not physical motion.
test('selected telemetry engages calibrated bounded tracking and expires without autonomous recovery', () => {
  let time = 1000
  const config = antennaFixtureConfig(), tracker = createAntennaTracker(config, () => time)
  expect(tracker.tick().directive).toBe('stop')
  expect(tracker.ingest(antennaFix(time, 1)).accepted).toBe(false)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
  expect(tracker.ingest(antennaFix(time, 1)).accepted).toBe(true)
  expect(tracker.engage()).toBe(true)
  time += 20
  const first = tracker.tick()
  expect(first.mode).toBe('tracking')
  expect(first.goal!.panDeg).toBeCloseTo(80, 8)
  expect(first.goal!.tiltDeg).toBeCloseTo(-2.005, 7)
  expect(Math.abs(first.velocity.panDegPerSecond)).toBeLessThanOrEqual(config.maxAccelerationDegPerSecond2 * 0.02)
  time += config.maxTickGapMs + 1
  expect(tracker.tick().reason).toBe('tick-gap')
  tracker.ingest(antennaFix(time, 2))
  expect(tracker.tick().directive).toBe('stop')
  expect(tracker.engage()).toBe(false)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
  time++
  tracker.ingest(antennaFix(time, 3)); expect(tracker.engage()).toBe(true)
  for (let i = 0; i < 30; i++) { time += 20; tracker.tick() }
  expect(tracker.tick().reason).toBe('stale-target')
})

test('replayed and wrong-boot selected fixes latch a stop, while unrelated vehicles cannot take over', () => {
  for (const fault of ['replay', 'boot'] as const) {
    let time = 1000
    const tracker = createAntennaTracker(antennaFixtureConfig(), () => time)
    const selection = { targetId: 'vehicle-1', telemetrySessionId: 'boot-1' }
    tracker.selectTarget(selection)
    const fix = antennaFix(time, 7)
    tracker.ingest(fix); tracker.engage(); time += 20; tracker.tick()
    expect(tracker.ingest({ ...antennaFix(time, 8), targetId: 'vehicle-2' }).reason).toBe('other-target')
    expect(tracker.tick().mode).toBe('tracking')
    expect(tracker.ingest(fault === 'replay' ? fix : { ...antennaFix(time, 8), telemetrySessionId: 'boot-2' }).reason).toBe(fault === 'replay' ? 'replay' : 'wrong-session')
    expect(tracker.tick().velocity).toEqual({ panDegPerSecond: 0, tiltDegPerSecond: 0 })
    tracker.selectTarget(selection)
    expect(tracker.ingest(fix).reason).toBe('replay')
    expect(tracker.tick().directive).toBe('stop')
  }
})

test('clock, data age, quality, geometry and travel faults all stop at the public boundary', () => {
  const cases = [
    { reason: 'clock', mutate: (f: ReturnType<typeof antennaFix>) => { f.capturedAtMs++ } },
    { reason: 'clock', mutate: (f: ReturnType<typeof antennaFix>) => { f.clockDomainId = 'wall-clock' } },
    { reason: 'clock', mutate: (f: ReturnType<typeof antennaFix>) => { f.clockUncertaintyMs = 6 } },
    { reason: 'stale-target', mutate: (f: ReturnType<typeof antennaFix>) => { f.capturedAtMs -= 501 } },
    { reason: 'uncertain-target', mutate: (f: ReturnType<typeof antennaFix>) => { f.horizontalAccuracyM = 6 } },
    { reason: 'invalid-target', mutate: (f: ReturnType<typeof antennaFix>) => { f.position.latitudeDeg = NaN } },
    { reason: 'invalid-target', mutate: (f: ReturnType<typeof antennaFix>) => { f.sequence = 1.5 } },
    { reason: 'link-quality', mutate: (f: ReturnType<typeof antennaFix>) => { f.link.snrDb = -1 } },
    { reason: 'link-quality', mutate: (f: ReturnType<typeof antennaFix>) => { f.link.capturedAtMs -= 501 } },
    { reason: 'singular-target', mutate: (f: ReturnType<typeof antennaFix>) => { f.position.longitudeDeg = 0 } },
    { reason: 'range', mutate: (f: ReturnType<typeof antennaFix>) => { f.position.longitudeDeg = 1 } },
    { reason: 'travel-limit', mutate: (f: ReturnType<typeof antennaFix>) => { f.position.ellipsoidHeightM = -1000 } },
  ] as const
  for (const { reason, mutate } of cases) {
    let time = 1000
    const tracker = createAntennaTracker(antennaFixtureConfig(), () => time)
    tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
    tracker.ingest(antennaFix(time, 1)); tracker.engage(); time += 20; tracker.tick()
    if (reason === 'stale-target') time += 501
    const bad = antennaFix(time, 2); mutate(bad); tracker.ingest(bad)
    const result = tracker.tick()
    expect(result.directive).toBe('stop'); expect(result.reason).toBe(reason)
    expect(result.velocity).toEqual({ panDegPerSecond: 0, tiltDegPerSecond: 0 })
  }
})

test('manual override is leased, emergency is latched and a backwards local clock revokes tracking', () => {
  let time = 1000
  const tracker = createAntennaTracker(antennaFixtureConfig(), () => time)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
  tracker.ingest(antennaFix(time, 1)); tracker.engage(); time += 20; tracker.tick()
  expect(tracker.manual({ panDeg: -20, tiltDeg: 10 }, 80)).toBe(true)
  time += 20; expect(tracker.tick().mode).toBe('manual')
  time += 60; expect(tracker.tick().reason).toBe('manual-expired')
  expect(tracker.engage()).toBe(false)
  tracker.emergencyStop(); time += 1
  expect(tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-2' })).toBe(false)
  expect(tracker.manual({ panDeg: 0, tiltDeg: 0 })).toBe(false)
  expect(tracker.tick().reason).toBe('emergency')
  expect(tracker.resetEmergency()).toBe(true)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-2' })
  tracker.ingest({ ...antennaFix(time, 1), telemetrySessionId: 'boot-2' }); tracker.engage()
  time--; expect(tracker.tick().reason).toBe('clock')
  time += 20; expect(tracker.tick().directive).toBe('stop')
})

test('shortest angular solution stops for cable twist rather than silently unwinding', () => {
  let time = 1000
  const config = antennaFixtureConfig()
  config.initialPanDeg = 230
  const tracker = createAntennaTracker(config, () => time)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
  const west = antennaFix(time, 1); west.position.longitudeDeg = -0.01
  tracker.ingest(west); tracker.engage(); time += 20
  expect(tracker.tick().reason).toBe('cable-twist') // 270 true - 10 calibration = 260 mechanical.
})

test('configuration, fixes and returned snapshots are isolated from caller mutation', () => {
  let time = 1000
  const config = antennaFixtureConfig(), tracker = createAntennaTracker(config, () => time)
  config.origin.latitudeDeg = 89; config.panMaxDeg = 1
  tracker.selectTarget(Object.assign({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' }, { extra: () => 1 }))
  const fix = Object.assign(antennaFix(time, 1), { extra: () => 1 }); tracker.ingest(fix); fix.position.longitudeDeg = -10
  tracker.engage(); time += 20
  const snapshot = tracker.tick(); expect(snapshot.goal!.panDeg).toBeCloseTo(80)
  snapshot.position.panDeg = 9999; snapshot.selection!.targetId = 'different'; snapshot.link!.rssiDbm = 0
  expect(tracker.tick().position.panDeg).toBeLessThan(1)
  expect(tracker.tick().selection!.targetId).toBe('vehicle-1')
  expect(tracker.tick().link!.rssiDbm).toBe(-50)
  expect(() => createAntennaTracker({ ...antennaFixtureConfig(), maxRateDegPerSecond: NaN }, () => time)).toThrow()
  expect(() => createAntennaTracker({ ...antennaFixtureConfig(), initialPanDeg: 250 }, () => time)).toThrow()
})

test('modeled bench follows independent moving local truth and reports RF correlation without claiming hardware', () => {
  const report = runAntennaBench()
  expect(report.evidence).toBe('modeled-bench')
  expect(report.physicalActuationEnabled).toBe(false)
  expect(report.pointing.samples).toBeGreaterThan(400)
  expect(report.pointing.maxErrorDeg!).toBeLessThan(3.5)
  expect(report.pointing.rmsErrorDeg!).toBeLessThan(2)
  expect(report.link.errorSquaredRssiCorrelation!).toBeCloseTo(-1, 5)
  expect(report.withinModeledPointingTolerance).toBe(true)
  expect(report.firstStop).toBeNull()
  for (const scenario of antennaBenchScenarios.filter(s => s !== 'nominal')) {
    const fault = runAntennaBench({ scenario })
    expect(fault.firstStop).not.toBeNull()
    expect(fault.final.directive).toBe('stop')
    expect(fault.trajectoryCommandsAfterStop).toBe(0)
  }
  expect(() => runAntennaBench({ seconds: 1 })).toThrow()
  expect(() => runAntennaBench({ scenario: 'anything' as never })).toThrow()
})

test('trajectory rate and acceleration stay bounded through a reversing target, including north wrap', () => {
  let time = 1000
  const c = antennaFixtureConfig(), tracker = createAntennaTracker(c, () => time)
  tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
  tracker.ingest(antennaFix(time, 1)); tracker.engage()
  let previous = tracker.tick()
  for (let i = 1; i <= 500; i++) {
    time += 20
    const next = antennaFix(time, i + 1)
    if (i > 200) next.position.longitudeDeg = -0.01
    tracker.ingest(next)
    const current = tracker.tick()
    expect(current.mode).toBe('tracking')
    for (const axis of ['panDegPerSecond', 'tiltDegPerSecond'] as const) {
      expect(Math.abs(current.velocity[axis])).toBeLessThanOrEqual(c.maxRateDegPerSecond + 1e-9)
      expect(Math.abs(current.velocity[axis] - previous.velocity[axis])).toBeLessThanOrEqual(c.maxAccelerationDegPerSecond2 * 0.02 + 1e-9)
    }
    expect(current.position.panDeg).toBeGreaterThanOrEqual(c.panMinDeg)
    expect(current.position.panDeg).toBeLessThanOrEqual(c.panMaxDeg)
    previous = current
  }
  expect(previous.position.panDeg).toBeCloseTo(-100, 2)
  const crossing = antennaPointing({ latitudeDeg: 0, longitudeDeg: 179.99, ellipsoidHeightM: 0 }, { latitudeDeg: 0, longitudeDeg: -179.99, ellipsoidHeightM: 0 })
  expect(crossing.azimuthDeg).toBeCloseTo(90, 8)
  expect(crossing.elevationDeg).toBeCloseTo(-0.01, 7)
})

// Native CLI seam: catches registration, aliases, parsing and JSON output, not packaging/hardware.
test('native antenna command exposes both names and rejects invalid durations at parse time', async () => {
  const command = (args: string[]) => Bun.spawn([process.execPath, '--no-env-file', `--config=${join(import.meta.dir, '../fixtures/process/bunfig.toml')}`, join(import.meta.dir, '../fixtures/antenna/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' })
  for (const name of ['antenna:bench', 'antenna:simulate']) {
    const child = command([name, '--seconds', '10'])
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(errors).toBe(''); expect(status).toBe(0)
    const report = JSON.parse(output)
    expect(report.evidence).toBe('modeled-bench'); expect(report.seconds).toBe(10)
  }
  for (const value of ['NaN', 'Infinity', '10.5', '9', '61', '1e1', '']) {
    const child = command(['antenna:bench', '--seconds', value])
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(output).toBe(''); expect(status).toBe(1); expect(errors).toContain('integer from 10 to 60')
  }
})

test('invalid operator selection and manual override fail closed before reporting an error', () => {
  for (const operation of ['selection', 'manual-lease', 'manual-travel', 'malformed-fix'] as const) {
    let time = 1000
    const tracker = createAntennaTracker(antennaFixtureConfig(), () => time)
    tracker.selectTarget({ targetId: 'vehicle-1', telemetrySessionId: 'boot-1' })
    tracker.ingest(antennaFix(time, 1)); tracker.engage(); time += 20; tracker.tick()
    if (operation === 'selection') expect(() => tracker.selectTarget(null as never)).toThrow()
    if (operation === 'manual-lease') expect(() => tracker.manual({ panDeg: 0, tiltDeg: 0 }, NaN)).toThrow()
    if (operation === 'manual-travel') expect(tracker.manual({ panDeg: Infinity, tiltDeg: 0 })).toBe(false)
    if (operation === 'malformed-fix') expect(tracker.ingest(null as never).accepted).toBe(false)
    expect(tracker.tick().directive).toBe('stop')
  }
})
