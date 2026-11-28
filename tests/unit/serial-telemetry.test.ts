import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { encodeFrame, encodeFrameV2 } from '../../resources/functions/drone/mavlink'
import { createMavlinkSigning } from '../../resources/functions/drone/drivers/signing'

const heartbeat = (autopilot: number, sequence: number, system = 1) =>
  encodeFrame(0, Uint8Array.from([0, 0, 0, 0, 2, autopilot, 0, 4, 3]), sequence, system, 1)
function battery(percent: number, sequence: number) {
  const payload = new Uint8Array(31)
  new DataView(payload.buffer).setInt8(30, percent)
  return encodeFrame(1, payload, sequence, 1, 1)
}
function positionPayload(bootMs: number, north: number) {
  const payload = new Uint8Array(28), view = new DataView(payload.buffer)
  view.setUint32(0, bootMs, true)
  view.setFloat32(4, north, true)
  view.setFloat32(12, -2, true)
  return payload
}
const position = (bootMs: number, north: number, sequence: number) => encodeFrame(32, positionPayload(bootMs, north), sequence, 1, 1)

test.skipIf(process.platform !== 'linux')('the native receiver consumes Linux tty bytes with no outbound traffic and ends on detach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-serial-test-'))
  const helper = join(root, 'pty')
  const compiled = Bun.spawnSync(['cc', '-std=c17', '-Wall', '-Wextra', '-Werror', '-o', helper, 'tests/fixtures/serial-telemetry-peer.c', '-lutil'])
  expect(compiled.stderr.toString()).toBe('')
  expect(compiled.exitCode).toBe(0)
  const peer = spawn(helper, { stdio: ['pipe', 'pipe', 'inherit'] })
  const peerExit = once(peer, 'close')
  const peerLines = createInterface({ input: peer.stdout })
  const peerOutput = peerLines[Symbol.asyncIterator]()
  const deadline = setTimeout(() => peer.kill('SIGKILL'), 30000)
  async function peerCommand(text: string) {
    peer.stdin.write(`${text}\n`)
    return (await peerOutput.next()).value
  }
  async function send(...chunks: Uint8Array[]) {
    expect(await peerCommand(`send ${Buffer.concat(chunks).toString('hex')}`)).toBe('sent')
  }
  async function withReceiver(run: (receiver: { sample: () => Promise<Record<string, unknown>>, stop: () => void, exit: () => Promise<{ code: unknown, signal: unknown, error: string }> }) => Promise<void>) {
    const stdinArgs = ['telemetry:receive', 'px4', '--serial', path, '--baud', '115200']
    const command = process.env.DRONE_SERIAL_TEST_CLI
    const child = spawn(command ?? './buddy', stdinArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'close')
    const lines = createInterface({ input: child.stdout })
    const output = lines[Symbol.asyncIterator]()
    let stderr = ''
    child.stderr.on('data', data => { stderr += String(data) })
    const guard = setTimeout(() => child.kill('SIGKILL'), 18000)
    const exit = async () => { const [code, signal] = await exited; return { code, signal, error: stderr } }
    try {
      let ready = false
      while (!ready) {
        const line = await output.next()
        if (line.done) throw new Error(`Receiver stopped before opening the tty. ${stderr}`)
        ready = line.value === `Receive-only px4 telemetry on ${path}`
      }
      await run({
        stop() { child.kill('SIGTERM') },
        exit,
        async sample() {
          const line = await output.next()
          if (line.done) throw new Error(`Receiver ended before reporting a sample. ${stderr}`)
          return JSON.parse(line.value)
        },
      })
    }
    finally {
      clearTimeout(guard)
      lines.close()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  }
  const path = (await peerOutput.next()).value as string
  try {
    expect(path).toMatch(/^\/dev\/pts\/\d+$/)
    await withReceiver(async ({ sample, stop, exit }) => {
      await send(heartbeat(3, 1), heartbeat(12, 2, 2), battery(10, 3), position(20, 100, 4))
      expect(await sample()).toMatchObject({ batteryPercent: -1, receivedAtMs: null, positionHealthy: false })
      const matched = heartbeat(12, 5)
      await send(matched.subarray(0, 7))
      await Bun.sleep(80)
      await send(matched.subarray(7), battery(86, 6), position(0xfffffff0, 12, 7))
      const initial = await sample()
      expect(initial).toMatchObject({ batteryPercent: 86, position: { north: 12, east: 0, down: -2 }, positionHealthy: false })
      await send(position(16, 18, 8))
      expect(await sample()).toMatchObject({ position: { north: 18, east: 0, down: -2 }, positionHealthy: false })
      const signing = createMavlinkSigning({ key: new Uint8Array(32).fill(7), linkId: 1, timestamp: () => 10n })
      const signed = encodeFrameV2(32, positionPayload(22, 42), 9, 1, 1, signing)
      await send(signed, position(16, 99, 10), position(12, 98, 11), position(20, NaN, 12), battery(2, 6))
      expect(await sample()).toMatchObject({ receivedAtMs: initial.receivedAtMs, position: { north: 18, east: 0, down: -2 }, batteryPercent: 86 })
      expect(await peerCommand('quiet')).toBe('quiet')
      stop()
      expect(await exit()).toEqual({ code: 0, signal: null, error: '' })
    })
    expect(await peerCommand('restored')).toBe('restored')
    await withReceiver(async ({ sample, exit }) => {
      expect(await sample()).toMatchObject({ receivedAtMs: null, positionHealthy: false })
      expect(await peerCommand('detach')).toBe('detached')
      expect(await exit()).toMatchObject({ code: 1, signal: null, error: expect.stringContaining('Telemetry receiver unavailable') })
    })
  }
  finally {
    clearTimeout(deadline)
    peerLines.close()
    if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL')
    await peerExit
    await rm(root, { recursive: true, force: true })
  }
}, 35000)
