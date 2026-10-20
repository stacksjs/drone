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
