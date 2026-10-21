import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'

// Native Stacks definitions through bin/drone.ts, executed as source with this pinned Bun.
// This is not a compiled-portable or hardware qualification.
async function sourceCommand(args: string[]) {
  const child = Bun.spawn([process.execPath, 'bin/drone.ts', 'cinema:simulate', ...args], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; child.kill() }, 60000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exitCode, timedOut }
  }
  finally { clearTimeout(guard) }
}

test('native source cinema command emits exactly one bounded completed summary through EOF', async () => {
  const result = await sourceCommand([])
  expect(result.timedOut).toBe(false)
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout.endsWith('\n')).toBe(true)
  expect(result.stdout.split('\n').length).toBe(2)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
  const summary = JSON.parse(result.stdout)
  expect(Object.keys(summary)).toEqual(['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated', 'selection', 'clock', 'mission', 'shot', 'captures', 'reconciliation', 'evaluation'])
  expect(summary.status).toBe('completed')
  expect(summary.reason).toBe('qualified')
  expect(summary.scenario).toBe('nominal')
  expect(summary.mission).toEqual({ state: 'completed', reason: 'landed', boardNeutral: true })
  expect(summary.physicalFlightEnabled).toBe(false)
  expect(summary.physicalGimbalActuationEnabled).toBe(false)
  expect(summary.identityAuthenticated).toBe(false)
  expect(summary.captures.length).toBe(3)
  expect(summary.captures.every((capture: { state: string, postStepAdmission: string, quality: { qualified: boolean } }) => capture.state === 'confirmed' && capture.postStepAdmission === 'valid' && capture.quality.qualified)).toBe(true)
  expect(Object.hasOwn(summary, 'gimbal')).toBe(false)
  expect(Object.hasOwn(summary, 'model')).toBe(false)
  expect(Object.hasOwn(summary.mission, 'trace')).toBe(false)
}, 70000)

for (const [scenario, status, reason, exitCode] of [
  ['body-disturbance', 'completed', 'qualified', 0],
  ['target-loss', 'halted', 'target-stale', 1],
  ['mechanical-limit', 'halted', 'joint-goal-limit', 1],
  ['camera-loss', 'halted', 'ack-deadline', 1],
  ['wrong-ack', 'halted', 'ack-scope', 1],
  ['rc-override', 'halted', 'authority-lost', 1],
] as const) test('native source cinema scenario ' + scenario + ' preserves model status and exit', async () => {
  const result = await sourceCommand(['--scenario', scenario])
  expect(result.timedOut).toBe(false)
  expect(result.exitCode).toBe(exitCode)
  expect(result.stderr).toBe('')
  const summary = JSON.parse(result.stdout)
  expect(summary.scenario).toBe(scenario)
  expect(summary.status).toBe(status)
  expect(summary.reason).toBe(reason)
  expect(summary.mission.boardNeutral).toBe(true)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
}, 70000)

test('native final cinema options reject arrays invalid strings and usage without private echo', async () => {
  for (const flags of [
    ['--scenario', 'private-cinema-sentinel'], ['--scenario', ''], ['--scenario=false'],
    ['--scenario', 'nominal', '--scenario', 'nominal'], ['--scenario'], ['--unknown-cinema-option'],
  ]) {
    const result = await sourceCommand(flags)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('private-cinema-sentinel')
    if (flags.length > 1 || flags[0] === '--scenario=false') {
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('Cinema simulation failed: invalid input, unavailable result or output failure\n')
    }
  }
}, 70000)

test('native source cinema closed stdout exits failure with only the fixed error', async () => {
  const child = spawn(process.execPath, ['bin/drone.ts', 'cinema:simulate'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy()
  let stderr = '', timedOut = false
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (Buffer.byteLength(stderr) > 8192) child.kill('SIGKILL') })
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
  let code: number | null
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { clearTimeout(guard) }
  expect(timedOut).toBe(false)
  expect(code).toBe(1)
  expect(stderr).toBe('Cinema simulation failed: invalid input, unavailable result or output failure\n')
}, 70000)

test('native source cinema delayed stdout consumption retains the complete single JSON line through EOF', async () => {
  const child = Bun.spawn([process.execPath, 'bin/drone.ts', 'cinema:simulate'], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; child.kill() }, 60000)
  try {
    await Bun.sleep(200)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(timedOut).toBe(false)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.split('\n').length).toBe(2)
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16384)
    expect(JSON.parse(stdout).status).toBe('completed')
  }
  finally { clearTimeout(guard) }
}, 70000)

test('Buddy discovers the same cinema command and delivers its bounded source summary', async () => {
  const path = process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':' + (process.env.PATH ?? '')
  const child = Bun.spawn(['./buddy', 'cinema:simulate'], { cwd: process.cwd(), env: { ...process.env, PATH: path }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; child.kill() }, 60000)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(timedOut).toBe(false)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.split('\n').length).toBe(2)
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16384)
    expect(JSON.parse(stdout).status).toBe('completed')
  }
  finally { clearTimeout(guard) }
}, 70000)


// The counted command seam catches native option/projection/stream delivery defects.
// It does not replace the independent full-image, readiness, replay or tail oracles.
const countedError = 'Counted cinema simulation failed: invalid input, unavailable result or output failure\n'
async function countedCommand(flags: string[], entry: 'source' | 'buddy' = 'source', output: 'normal' | 'delayed' | 'closed' = 'normal') {
  const args = entry === 'source' ? ['--no-install', 'bin/drone.ts', 'cinema:translate', ...flags] : ['cinema:translate', ...flags]
  const path = process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':' + (process.env.PATH ?? '')
  const child = spawn(entry === 'source' ? process.execPath : './buddy', args, { cwd: process.cwd(), env: { ...process.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false
  if (output === 'closed') child.stdout.destroy()
  if (output === 'delayed') child.stdout.pause()
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > 16384) { overflow = true; child.kill('SIGKILL'); return }
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes > 8192) { overflow = true; child.kill('SIGKILL'); return }
    stderr += chunk.toString('utf8')
  })
  const resume = output === 'delayed' ? setTimeout(() => child.stdout.resume(), 200) : null
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { stdout, stderr, exitCode, timedOut, overflow }
  }
  finally { clearTimeout(guard); if (resume !== null) clearTimeout(resume) }
}

function countedObject(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Expected owned summary object')
  if (keys) expect(Object.keys(value)).toEqual(keys)
  return value as Record<string, unknown>
}
function countedNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected finite summary number')
  return value
}
function countedArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected summary array')
  return value
}
function countedVector(value: unknown): [number, number, number] {
  const array = countedArray(value)
  expect(array.length).toBe(3)
  return [countedNumber(array[0]), countedNumber(array[1]), countedNumber(array[2])]
}
function countedFinite(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { countedNumber(value); return }
  if (Array.isArray(value)) { for (const item of value) countedFinite(item); return }
  for (const item of Object.values(countedObject(value))) countedFinite(item)
}
function countedSummary(text: string) {
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384)
  expect(text.endsWith('\n')).toBe(true)
  expect(text.split('\n').length).toBe(2)
  const parsed: unknown = JSON.parse(text)
  countedFinite(parsed)
  const summary = countedObject(parsed, ['version', 'evidence', 'run', 'clock', 'encoderMethod', 'mission', 'shot', 'manager', 'translation', 'captures', 'reconciliation', 'evaluation'])
  expect(summary.version).toBe(1)
  expect(summary.evidence).toBe('owned-counted-cinema-cli-summary')
  const run = countedObject(summary.run, ['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated'])
  expect(run.version).toBe(4)
  expect(run.evidence).toBe('owned-cinema-counted-dolly-simulation')
  expect(run.profile).toBe('straight-poi-dolly-counted-v1')
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.physicalGimbalActuationEnabled).toBe(false)
  expect(run.identityAuthenticated).toBe(false)
  countedObject(summary.clock, ['domain', 'vehiclePlantStepMs', 'policyStepMs', 'firstInstrumentAtMs', 'gimbalStepMs', 'encoderDelayMs', 'tailMs'])
  expect(summary.encoderMethod).toEqual({ version: 1, method: 'count-difference-v1', quantumRad: 0.001, intervalMs: 20, delayMs: 20, rateUnitRadS: 0.05, countLimit: 8000, deltaLimit: 16000, rounding: 'nearest-ties-positive' })
  const mission = countedObject(summary.mission, ['version', 'planId', 'state', 'reason', 'boardNeutral', 'boardFault', 'finalTruthPositionM'])
  expect(mission.version).toBe(4)
  expect(mission.planId).toBe('cinema-dolly-counted-v1')
  expect(mission.boardNeutral).toBe(true)
  expect(mission.boardFault).toBe(null)
  countedVector(mission.finalTruthPositionM)
  const shot = countedObject(summary.shot, ['phase', 'loiterObservedAtMs', 'latestStartMs', 'readySinceMs', 'readySampleCount', 'startedAtMs', 'completedAtMs', 'firstFault', 'counters', 'retirement'])
  if (shot.firstFault !== null) countedObject(shot.firstFault, ['atMs', 'code'])
  const counters = countedObject(shot.counters, ['trackingCommands', 'shutterAttempts', 'ackReceipts', 'confirmedCaptures', 'uncertainCaptures', 'trackingCommandsAfterRetirement', 'shutterAttemptsAfterRetirement'])
  expect(counters.trackingCommandsAfterRetirement).toBe(0)
  expect(counters.shutterAttemptsAfterRetirement).toBe(0)
  countedObject(shot.retirement, ['atMs', 'cause', 'requestedTorqueNm'])
  const manager = countedObject(summary.manager, ['firstInhibit', 'counters', 'retirement', 'lastAccepted'])
  if (manager.firstInhibit !== null) countedObject(manager.firstInhibit, ['atMs', 'code'])
  countedObject(manager.counters, ['acceptedCommands', 'rejectedForeignCommands', 'rejectedSelectedCommands', 'commandsAfterRetirement'])
  countedObject(manager.retirement, ['atMs', 'directive'])
  if (manager.lastAccepted !== null) countedObject(manager.lastAccepted, ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs'])
  const translation = countedObject(summary.translation, ['version', 'evidence', 'frame', 'fromM', 'toM', 'planDefaultSpeedMps', 'taskRates', 'policy', 'timeline', 'metrics', 'smoothnessQualified'])
  expect(translation.version).toBe(3)
  expect(translation.evidence).toBe('owned-cinema-translation-audit')
  expect(translation.frame).toBe('LOCAL_NED')
  expect(translation.fromM).toEqual([0, 0, -1.2])
  expect(translation.toM).toEqual([2, 0, -1.2])
  expect(translation.planDefaultSpeedMps).toBe(0.6)
  expect(translation.taskRates).toEqual([
    { taskId: 'takeoff', kind: 'takeoff', speedMps: 0.6 }, { taskId: 'stage', kind: 'readiness-loiter', speedMps: 0.6 },
    { taskId: 'dolly', kind: 'waypoint', speedMps: 0.2 }, { taskId: 'return', kind: 'return', speedMps: 0.6 }, { taskId: 'land', kind: 'land', speedMps: 0.6 },
  ])
  expect(translation.policy).toEqual({ kind: 'native-waypoint-speed-ramp', stageTaskId: 'stage', moveTaskId: 'dolly', startGridMs: 20, maxMoveEntryAfterStageMs: 1600, movingEstimatedCorridorM: 0.2, shotDurationMs: 8000, truthCadenceMs: 20, truthFirstOffsetMs: 20, jerkQualification: 'unqualified-at-4ms', handshake: { nativeVersion: 4, readinessSourceId: 'cinema-stage-counted-v1', minimumDwellMs: 1500, taskTimeoutMs: 3000, posePrediction: 'qualified-gyro-hold', predictedEpoch: 'current-policy-epoch', encoderMethod: 'count-difference-v1' } })
  expect(translation.smoothnessQualified).toBe(false)
  const timeline = countedObject(translation.timeline, ['stageEnteredAtMs', 'moveEnteredAtMs', 'moveObservedAtMs', 'readyThroughAtMs', 'readySamplesAtEntry', 'startAdmission', 'normalCloseAdmission', 'firstInvalidJoin'])
  if (timeline.firstInvalidJoin !== null) countedObject(timeline.firstInvalidJoin, ['atMs', 'kind', 'reason'])
  expect(timeline.startAdmission).toBe('valid')
  const metrics = countedObject(translation.metrics, ['sampleCount', 'durationMs', 'forwardDisplacementM', 'maxCrossTrackM', 'maxSpeedMps', 'maxAccelerationMps2', 'maxSampledJerkMps3', 'captureForwardDisplacementM', 'captureForwardSpeedMps', 'firstExposureForwardDisplacementM', 'firstExposureForwardSpeedMps', 'nominalWitness', 'sourceMotionWitness'])
  const captures = countedArray(summary.captures).map(value => {
    const capture = countedObject(value, ['sequence', 'state', 'reason', 'shotOffsetMs', 'issuedAtMs', 'capturedAtMs', 'deadlineMs', 'acknowledgedAtMs', 'receivedAtMs', 'postStepAdmission', 'quality', 'bodyPositionM', 'encoder'])
    countedObject(capture.quality, ['expectedPixel', 'observedPixel', 'errorPx', 'markerPixels', 'qualified'])
    const encoder = countedObject(capture.encoder, ['version', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'deltaCounts', 'velocityRadS'])
    expect(encoder.version).toBe(1)
    expect(encoder.receivedAtMs).toBe(capture.issuedAtMs)
    expect(encoder.capturedAtMs).toBe(countedNumber(capture.issuedAtMs) - 20)
    const delta = countedVector(encoder.deltaCounts), velocity = countedVector(encoder.velocityRadS)
    expect(velocity).toEqual([delta[0] * 0.05, delta[1] * 0.05, delta[2] * 0.05])
    expect(countedVector(encoder.positionCounts).every(Number.isSafeInteger)).toBe(true)
    countedVector(capture.bodyPositionM)
    return capture
  })
  expect(captures.length).toBeLessThanOrEqual(3)
  countedObject(summary.reconciliation, ['invalidCaptureSequences', 'earliestInvalidAtMs'])
  const evaluation = countedObject(summary.evaluation, ['motion', 'frames', 'qualified'])
  countedObject(evaluation.motion, ['rows', 'tailRows', 'maxRateRadS', 'maxAccelerationRadS2', 'maxJerkRadS3', 'maxAppliedTorqueNm', 'maxTorqueSlewNmS', 'withinDynamicBounds', 'withinMechanicalBounds'])
  countedObject(evaluation.frames, ['exposed', 'confirmed', 'qualified', 'maxErrorPx'])
  return { summary, run, mission, shot, manager, translation, timeline, metrics, captures, evaluation }
}

for (const entry of ['source', 'buddy'] as const) {
  test('counted translation ' + entry + ' nominal exposes actual admitted moving captures and landing', async () => {
    const result = await countedCommand([], entry)
    expect(result.timedOut).toBe(false); expect(result.overflow).toBe(false)
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe('')
    const s = countedSummary(result.stdout)
    expect(s.run.scenario).toBe('nominal'); expect(s.run.status).toBe('completed'); expect(s.run.reason).toBe('qualified')
    expect(s.mission.state).toBe('completed'); expect(s.mission.reason).toBe('landed')
    expect(s.shot.phase).toBe('completed'); expect(s.shot.firstFault).toBe(null)
    expect(countedNumber(s.shot.completedAtMs) - countedNumber(s.shot.startedAtMs)).toBe(8000)
    expect(countedNumber(s.shot.latestStartMs) - countedNumber(s.shot.loiterObservedAtMs)).toBe(1600)
    expect(s.timeline.readySamplesAtEntry).toBe(26); expect(s.timeline.normalCloseAdmission).toBe('valid'); expect(s.timeline.firstInvalidJoin).toBe(null)
    expect(s.metrics.nominalWitness).toBe('satisfied'); expect(countedNumber(s.metrics.captureForwardDisplacementM)).toBeGreaterThanOrEqual(0.5)
    expect(countedVector(s.metrics.captureForwardSpeedMps).every(n => n > 0)).toBe(true)
    expect(s.evaluation.qualified).toBe(true)
    expect(s.captures.map(c => c.shotOffsetMs)).toEqual([1000, 3000, 7000])
    expect(s.captures.every(c => c.state === 'confirmed' && c.reason === 'acknowledged' && c.postStepAdmission === 'valid')).toBe(true)
    expect(s.captures.every(c => countedObject(c.quality).qualified === true && countedNumber(countedObject(c.quality).errorPx) <= 2)).toBe(true)
    expect(countedObject(s.summary.reconciliation).invalidCaptureSequences).toEqual([])
  }, 70000)

  test('counted translation ' + entry + ' source expiry prints a real uncertain exposure and exits failure', async () => {
    const result = await countedCommand(['--scenario', 'source-expiry-with-foreign'], entry)
    expect(result.timedOut).toBe(false); expect(result.overflow).toBe(false)
    expect(result.exitCode).toBe(1); expect(result.stderr).toBe('')
    const s = countedSummary(result.stdout), start = countedNumber(s.shot.startedAtMs)
    expect(s.run.scenario).toBe('source-expiry-with-foreign'); expect(s.run.status).toBe('halted'); expect(s.run.reason).toBe('gimbal-source-expired')
    expect(s.mission.state).toBe('aborted'); expect(s.mission.reason).toBe('operator-abort')
    expect(s.shot.firstFault).toEqual({ atMs: start + 1020, code: 'gimbal-source-expired' })
    expect(s.manager.firstInhibit).toEqual({ atMs: start + 1020, code: 'gimbal-source-expired' })
    const held = countedObject(s.manager.lastAccepted)
    expect(held.issuedAtMs).toBe(start + 940); expect(held.expiresAtMs).toBe(start + 1020)
    expect(countedObject(s.manager.counters).rejectedForeignCommands).toBe(1)
    expect(s.metrics.sourceMotionWitness).toBe('satisfied')
    expect(countedNumber(s.metrics.firstExposureForwardDisplacementM)).toBeGreaterThan(0)
    expect(countedNumber(s.metrics.firstExposureForwardSpeedMps)).toBeGreaterThan(0)
    expect(s.captures.length).toBe(1)
    const capture = s.captures[0]!
    expect(capture.issuedAtMs).toBe(start + 1000); expect(capture.capturedAtMs).toBe(start + 1000)
    expect(capture.state).toBe('uncertain'); expect(capture.reason).toBe('gimbal-source-expired')
    expect(capture.acknowledgedAtMs).toBe(null); expect(capture.receivedAtMs).toBe(null)
    expect(countedObject(s.evaluation.frames).exposed).toBe(1); expect(s.evaluation.qualified).toBe(false)
    expect(s.timeline.normalCloseAdmission).toBe('not-attempted')
  }, 70000)
}

for (const scenario of ['nominal', 'source-expiry-with-foreign'] as const) test('counted translation summary maps the actual public result for ' + scenario, async () => {
  const result = await countedCommand(['--scenario', scenario])
  expect(result.timedOut).toBe(false); expect(result.overflow).toBe(false)
  expect(result.exitCode).toBe(scenario === 'nominal' ? 0 : 1); expect(result.stderr).toBe('')
  const s = countedSummary(result.stdout)
  const { simulateCountedTranslatingCinema } = await import('../../resources/functions/drone/cinema/runtime')
  const actual = simulateCountedTranslatingCinema({ scenario })
  const buddy = await countedCommand(['--scenario', scenario], 'buddy')
  expect(buddy.timedOut).toBe(false); expect(buddy.overflow).toBe(false)
  expect(buddy.exitCode).toBe(result.exitCode); expect(buddy.stderr).toBe(''); expect(buddy.stdout).toBe(result.stdout)
  for (const key of ['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated'] as const) expect(s.run[key]).toEqual(actual[key])
  expect(s.mission.version).toBe(actual.mission.trace.version); expect(s.mission.planId).toBe(actual.mission.trace.plan.id)
  expect(s.mission.state).toBe(actual.mission.terminalState); expect(s.mission.reason).toBe(actual.mission.terminalReason)
  for (const key of ['boardNeutral', 'boardFault'] as const) expect(s.mission[key]).toEqual(actual.mission[key])
  expect(s.summary.clock).toEqual(actual.model.clock); expect(s.summary.encoderMethod).toEqual(actual.model.encoderMeasurement)
  expect(s.mission.finalTruthPositionM).toEqual(actual.mission.finalTruthPositionM)
  for (const key of ['phase', 'loiterObservedAtMs', 'latestStartMs', 'readySinceMs', 'readySampleCount', 'startedAtMs', 'completedAtMs', 'firstFault', 'counters'] as const) expect(s.shot[key]).toEqual(actual.shot[key])
  const retired = countedObject(s.shot.retirement)
  for (const key of ['atMs', 'cause', 'requestedTorqueNm'] as const) expect(retired[key]).toEqual(actual.shot.retirement[key])
  if (actual.manager.lastAccepted) {
    const held = countedObject(s.manager.lastAccepted)
    for (const key of ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs'] as const) expect(held[key]).toEqual(actual.manager.lastAccepted[key])
  }
  else expect(s.manager.lastAccepted).toBe(null)
  for (const key of ['firstInhibit', 'counters', 'retirement'] as const) expect(s.manager[key]).toEqual(actual.manager[key])
  for (const key of ['version', 'evidence', 'frame', 'fromM', 'toM', 'planDefaultSpeedMps', 'taskRates', 'policy', 'timeline', 'metrics', 'smoothnessQualified'] as const) expect(s.translation[key]).toEqual(actual.translation[key])
  expect(s.summary.reconciliation).toEqual(actual.reconciliation); expect(s.summary.evaluation).toEqual(actual.evaluation)
  expect(s.captures.length).toBe(actual.captures.length)
  for (const [i, capture] of actual.captures.entries()) {
    const emitted = s.captures[i]!
    for (const key of ['sequence', 'state', 'reason', 'shotOffsetMs', 'issuedAtMs', 'capturedAtMs', 'deadlineMs', 'postStepAdmission'] as const) expect(emitted[key]).toEqual(capture[key])
    expect(emitted.acknowledgedAtMs).toBe(capture.ack?.acknowledgedAtMs ?? null)
    expect(emitted.receivedAtMs).toBe(capture.ack?.receivedAtMs ?? null)
    expect(emitted.quality).toEqual(capture.quality); expect(emitted.bodyPositionM).toEqual(capture.actual?.bodyPositionM ?? null)
    const encoder = countedObject(emitted.encoder)
    for (const key of ['version', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'deltaCounts', 'velocityRadS'] as const) expect(encoder[key]).toEqual(capture.encoder[key])
  }
}, 140000)

test('counted translation native options reject nonmembers without echo and keep native usage handling', async () => {
  for (const flags of [['--scenario', 'private-counted-sentinel'], ['--scenario', ''], ['--scenario=false'], ['--scenario', 'nominal', '--scenario', 'nominal']]) {
    const result = await countedCommand(flags)
    expect(result.timedOut).toBe(false); expect(result.overflow).toBe(false)
    expect(result.exitCode).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe(countedError)
    expect(result.stderr).not.toContain('private-counted-sentinel')
  }
  for (const flags of [['--scenario'], ['--unknown-counted-option'], ['--speed', '0.2'], ['--output', 'unused'], ['--provider', 'unused']]) {
    const result = await countedCommand(flags)
    expect(result.timedOut).toBe(false); expect(result.overflow).toBe(false)
    expect(result.exitCode).not.toBe(0); expect(result.stdout).toBe('')
  }
  const help = await countedCommand(['--help'])
  expect(help.timedOut).toBe(false); expect(help.overflow).toBe(false); expect(help.exitCode).toBe(0)
  expect(help.stdout).toContain('cinema:translate'); expect(help.stdout).toContain('--scenario')
}, 70000)

test('counted translation awaits delayed stdout and fails closed when stdout is closed', async () => {
  const delayed = await countedCommand([], 'source', 'delayed')
  expect(delayed.timedOut).toBe(false); expect(delayed.overflow).toBe(false)
  expect(delayed.exitCode).toBe(0); expect(delayed.stderr).toBe('')
  expect(countedSummary(delayed.stdout).run.status).toBe('completed')
  const closed = await countedCommand([], 'source', 'closed')
  expect(closed.timedOut).toBe(false); expect(closed.overflow).toBe(false)
  expect(closed.exitCode).toBe(1); expect(closed.stderr).toBe(countedError)
}, 140000)
