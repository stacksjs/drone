import { commandFrame, decodeRuntimeFrame, encodeRuntimeFrame } from '../runtime/protocol'

interface HostEvidenceInput { kind: 'tx' | 'rx', bytes: Uint8Array }

/** Validate retained host-only protocol evidence. This cannot confirm a new slot or attest a process exit. */
export function verifyRuntimeHostTranscript(inputs: ReadonlyArray<HostEvidenceInput>, identity: { bootId: string, sessionId: string }) {
  const boot = BigInt(identity.bootId), session = BigInt(identity.sessionId)
  let index = 0, ticks = 1, time = 1000, expiry = 0, commandSequence = 1, stateBytes = 0
  function pair(request: string, boundSession: bigint) {
    const tx = inputs[index++], rx = inputs[index++]
    if (!tx || !rx || tx.kind !== 'tx' || rx.kind !== 'rx' || !Buffer.from(tx.bytes).equals(Buffer.from(request))) throw new Error('Host health transcript request rejected')
    let status
    try { status = decodeRuntimeFrame(rx.bytes) }
    catch (cause) { throw new Error('Host health transcript status rejected', { cause }) }
    const lease = Math.max(expiry - time, 0)
    if (!stateBytes) stateBytes = status.stateBytes
    if (status.kind !== 'status' || status.sequence !== index / 2 || status.bootId !== boot || status.sessionId !== boundSession
      || status.ticks !== ticks || status.sampleTimeUs !== BigInt(time) || status.sample !== ticks - 1000
      || status.leaseUs !== lease || status.flags !== (67 | (lease ? 4 : 0)) || status.deadlineMisses !== 0
      || status.maxExecutionUs !== 0 || stateBytes < 1 || stateBytes > 128 || status.stateBytes !== stateBytes) throw new Error('Host health transcript identity, progress or health rejected')
  }
  function frame(kind: 'hello' | 'lease' | 'stop') {
    if (kind === 'lease') expiry = time + 100000
    if (kind === 'stop') expiry = 0
    const command = commandFrame(kind, commandSequence++, kind === 'hello' ? 0n : boot, session, kind === 'hello' ? 0n : BigInt(time), kind === 'lease' ? 100000 : 0)
    pair(`frame ${Buffer.from(encodeRuntimeFrame(command)).toString('hex')}`, session)
  }
  pair('tick 1000', 0n)
  frame('hello')
  frame('lease')
  for (let step = 1; step < 100; step++) {
    ticks++; time += 1000
    pair(`tick ${time}`, session)
    if (step % 20 === 0) frame('lease')
  }
  frame('stop')
  if (index !== inputs.length || index !== 214) throw new Error('Host health transcript length rejected')
}
