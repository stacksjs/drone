import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const failure = 'Farming collection preview unavailable: invalid declaration, rejected collection or output failure\n'
const example = resolve('examples/farming-collection.json')

async function command(request: string, directory: string, entry: 'source' | 'buddy' = 'source', mode: 'normal' | 'delayed' | 'closed' | 'both-closed' = 'normal') {
  const path = process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':' + (process.env.PATH ?? '')
  const child = spawn(entry === 'source' ? process.execPath : './buddy', entry === 'source' ? ['--no-install', 'bin/drone.ts', 'farming:collect', request, directory] : ['farming:collect', request, directory], {
    cwd: process.cwd(), env: { ...process.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false, stdoutEof = false, stderrEof = false, pausedAfterMarker = false
  if (mode === 'closed' || mode === 'both-closed') child.stdout.destroy()
  if (mode === 'both-closed') child.stderr.destroy()
  if (mode === 'delayed') child.stdout.pause()
  child.stdout.on('end', () => { stdoutEof = true })
  child.stderr.on('end', () => { stderrEof = true })
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 16777217 - stdoutBytes)
    stdoutBytes += chunk.length
    if (remaining) stdout.push(chunk.subarray(0, remaining))
    if (stdoutBytes > 16777216) { overflow = true; child.kill('SIGKILL') }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 4097 - stderrBytes)
    stderrBytes += chunk.length
    if (remaining) stderr.push(chunk.subarray(0, remaining))
    if (stderrBytes > 4096) { overflow = true; child.kill('SIGKILL') }
  })
  let resume: ReturnType<typeof setTimeout> | undefined
  const marker = mode === 'delayed' ? setInterval(() => {
    if (!existsSync(join(directory, 'attempt/manifest.json'))) return
    clearInterval(marker!)
    resume = setTimeout(() => { pausedAfterMarker = child.exitCode === null; child.stdout.resume() }, 200)
  }, 20) : undefined
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120000)
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, overflow, timedOut, stdoutEof, stderrEof, pausedAfterMarker }
  }
  finally {
    clearTimeout(guard)
    if (marker !== undefined) clearInterval(marker)
    if (resume !== undefined) clearTimeout(resume)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

// The real CLI seam qualifies wire/exit/persistence and native command delivery, not physical operation.
test('source and native Buddy deliver the same complete synthetic collection through EOF', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-cli-'))
  try {
    const results: string[] = []
    for (const entry of ['source', 'buddy'] as const) {
      const directory = join(parent, entry)
      const actual = await command(example, directory, entry)
      expect(actual.timedOut).toBe(false)
      expect(actual.overflow).toBe(false)
      expect(actual.exitCode).toBe(0)
      expect(actual.stdoutEof && actual.stderrEof).toBe(true)
      expect(actual.stderr).toBe('')
      expect(actual.stdout.split('\n')).toHaveLength(2)
      const delivery = JSON.parse(actual.stdout)
      expect(delivery.kind).toBe('farming-synthetic-collection-delivery')
      expect(delivery.record.outcome.status).toBe('completed')
      expect(delivery.record.layer.cells).toHaveLength(256)
      expect(JSON.parse(readFileSync(join(directory, 'attempt/result.json'), 'utf8'))).toEqual(delivery.record)
      results.push(actual.stdout)
    }
    // Both are the same source observation method and runtime. Standalone has a different method.
    expect(results[1]).toBe(results[0])
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 260000)

test('collection CLI refuses private invalid input and existing final outputs', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-cli-reject-'))
  try {
    const invalid = join(parent, 'private-invalid.json'), link = join(parent, 'private-link.json'), bom = join(parent, 'bom.json')
    writeFileSync(invalid, '{private-input-sentinel')
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(example)]))
    symlinkSync(example, link)
    for (const request of [join(parent, 'private-missing.json'), parent, invalid, link, bom]) {
      const directory = join(parent, 'uncreated')
      const actual = await command(request, directory)
      expect(actual.timedOut || actual.overflow).toBe(false)
      expect(actual.exitCode).toBe(1)
      expect(actual.stdoutEof && actual.stderrEof).toBe(true)
      expect(actual.stdout).toBe('')
      expect(actual.stderr).toBe(failure)
      expect(existsSync(directory)).toBe(false)
    }
    const file = join(parent, 'existing-file'), finalLink = join(parent, 'output-link')
    writeFileSync(file, 'retained-original')
    symlinkSync(file, finalLink)
    for (const directory of [file, finalLink, parent]) {
      const actual = await command(example, directory)
      expect(actual.exitCode).toBe(1)
      expect(actual.stdout).toBe('')
      expect(actual.stderr).toBe(failure)
      expect(readFileSync(file, 'utf8')).toBe('retained-original')
    }
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 260000)

test('collection CLI retains noncompleted zero-capture evidence with exit 2', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-cli-incomplete-'))
  try {
    const declaration = JSON.parse(readFileSync(example, 'utf8'))
    declaration.simulation.seconds = 8
    const request = join(parent, 'request.json'), directory = join(parent, 'attempt')
    writeFileSync(request, JSON.stringify(declaration))
    const actual = await command(request, directory)
    expect(actual.timedOut || actual.overflow).toBe(false)
    expect(actual.exitCode).toBe(2)
    expect(actual.stdoutEof && actual.stderrEof).toBe(true)
    expect(actual.stderr).toBe('')
    const record = JSON.parse(actual.stdout).record
    expect(record.outcome.status).toBe('incomplete')
    expect(record.outcome.captures).toBe(0)
    expect(record.outcome.boardNeutral).toBe(true)
    expect(record.outcome.lastMissionResult.state).toBe('running')
    expect(record.outcome.lastMissionResult.targetM).not.toBeNull()
    expect(record.operationalMissionCompleted).toBe(false)
    expect(record.layer.cells).toHaveLength(256)
    expect(record.layer.cells.every((cell: { ndvi: unknown, source: unknown, reason: string }) => cell.ndvi === null && cell.source === null && cell.reason === 'uncovered')).toBe(true)
    expect(record.layer.observedAreaM2).toBe(0)
    expect(record.layer.meanNdvi).toBeNull()
    expect(existsSync(join(directory, 'attempt/manifest.json'))).toBe(true)
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 130000)

test('full 4096-cell 32-parcel delivery waits for a slow reader after publication', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-cli-large-'))
  try {
    const declaration = JSON.parse(readFileSync(example, 'utf8'))
    declaration.config.gridResolutionM = .025
    declaration.config.parcels = Array.from(Array(32).keys(), index => ({ id: `parcel-${index}`, name: 'n'.repeat(100), boundsM: [-.8 + index * .05, -.8, -.8 + (index + 1) * .05, .8] }))
    const request = join(parent, 'request.json'), directory = join(parent, 'attempt')
    writeFileSync(request, JSON.stringify(declaration))
    const actual = await command(request, directory, 'source', 'delayed')
    expect(actual.timedOut || actual.overflow).toBe(false)
    expect(actual.exitCode).toBe(0)
    expect(actual.stdoutEof && actual.stderrEof).toBe(true)
    expect(actual.pausedAfterMarker).toBe(true)
    expect(actual.stderr).toBe('')
    expect(Buffer.byteLength(actual.stdout)).toBeGreaterThan(1048576)
    const record = JSON.parse(actual.stdout).record
    expect(record.layer.cells).toHaveLength(4096)
    expect(record.layer.parcels).toHaveLength(32)
    expect(record.layer.fieldAreaM2).toBeCloseTo(2.56, 9)
    for (const parcel of record.layer.parcels) expect(parcel.areaM2).toBeCloseTo(.08, 9)
    expect(JSON.parse(readFileSync(join(directory, 'attempt/result.json'), 'utf8'))).toEqual(record)
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 130000)

test('collection output-pipe failure preserves completed artifacts and consumes diagnostic failure', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-cli-pipe-'))
  try {
    for (const mode of ['closed', 'both-closed'] as const) {
      const directory = join(parent, mode)
      const actual = await command(example, directory, 'source', mode)
      expect(actual.timedOut || actual.overflow).toBe(false)
      expect(actual.exitCode).toBe(1)
      expect(actual.stderr).toBe(mode === 'closed' ? failure : '')
      expect(existsSync(join(directory, 'dataset/manifest.json'))).toBe(true)
      expect(existsSync(join(directory, 'attempt/manifest.json'))).toBe(true)
      expect(JSON.parse(readFileSync(join(directory, 'attempt/result.json'), 'utf8')).outcome.status).toBe('completed')
    }
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 260000)
