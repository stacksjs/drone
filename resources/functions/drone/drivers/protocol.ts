import type { MavlinkFrame } from '../mavlink'
import type { AutopilotDriverId } from './profiles'
import type { DriverCapabilities, DriverParameter, MissionWaypoint, ParameterType } from './messages'
import { driverProfiles } from './profiles'
import { commandPayload, driverProtocolLimits as limits, messageView, missionAckPayload, missionCountPayload, normalizeWaypoint, parameterBytes, parameterId, parameterResponseId, parseCapabilities, parseParameter, parseWaypoint, readParameterPayload, setParameterPayload, waypointPayload } from './messages'
export type DriverErrorCode = 'read-only' | 'busy' | 'unavailable' | 'timeout' | 'cancelled' | 'rejected' | 'invalid-response' | 'ambiguous' | 'closed' | 'transport-lost'
export class DriverProtocolError extends Error {
  constructor(public readonly code: DriverErrorCode, message: string) { super(message); this.name = 'DriverProtocolError' }
}
export interface DriverOperationOptions { signal?: AbortSignal }
export interface CommandAcknowledgement { command: number, result: 0, progress: number | null, executionConfirmed: false }
interface Pending {
  key: string
  deadline: number
  due: number
  attempts: number
  inProgress: boolean
  resend: (confirmation: number) => void
  receive: (frame: MavlinkFrame) => void
  reject: (error: DriverProtocolError) => void
  cleanup: () => void
  keys: Set<string>
}
interface Operation<T> {
  phase: (send: (confirmation: number) => void) => void
  receive: (callback: (frame: MavlinkFrame) => void) => void
  progress: () => void
  success: (value: T) => void
  fail: (code: DriverErrorCode, message: string, uncertain?: boolean) => void
}

/** Poll-driven microservices. One transaction, one pinned source, no physical output path. */
export function createDriverProtocol(options: { driver: AutopilotDriverId, kind: 'sitl' | 'telemetry-only', systemId: number, componentId: number, now: () => number, transmit: (id: number, payload: Uint8Array) => void }) {
  const { driver, kind, systemId, componentId, now, transmit } = options
  if (!['ardupilot', 'px4'].includes(driver) || !['sitl', 'telemetry-only'].includes(kind) || ![systemId, componentId].every(id => Number.isInteger(id) && id > 0 && id <= 255)) throw new TypeError('Invalid protocol profile or target identity')
  let capabilities: DriverCapabilities | null = null, pending: Pending | null = null, terminal: DriverProtocolError | null = null, lastNow = -Infinity, heartbeatAt = -Infinity, nextHeartbeat = Infinity, knownMissionCount: number | null = null
  const quarantine = new Set<string>()
  let completedDownload: { untilMs: number, count: number, finalItem: string | null } | null = null
  function end(error: DriverProtocolError, uncertain = true) {
    const p = pending
    if (!p) return
    if (p.key === 'mission') completedDownload = null
    pending = null; p.cleanup()
    if (uncertain) { for (const key of p.keys) quarantine.add(key); if (quarantine.size >= 64) terminal = new DriverProtocolError('ambiguous', 'Too many ambiguous transactions; reconnect') }
    p.reject(error)
  }
  function close(code: DriverErrorCode = 'closed', message = 'Protocol session closed') { completedDownload = null; terminal ??= new DriverProtocolError(code, message); end(terminal) }
  function clock() {
    const t = now()
    if (!Number.isFinite(t) || t < 0 || t < lastNow) { close('transport-lost', 'Protocol clock invalid or reversed'); return null }
    lastNow = t
    return t
  }
  function emit(id: number, bytes: Uint8Array) {
    if (kind !== 'sitl' || terminal) return
    try { transmit(id, bytes) }
    catch (error) { close('transport-lost', error instanceof Error ? error.message : String(error)) }
  }
  function tick() {
    const t = clock()
    if (terminal || t === null) return
    if (completedDownload && t >= completedDownload.untilMs) completedDownload = null
    if (heartbeatAt !== -Infinity && t - heartbeatAt > limits.heartbeatMs) { close('transport-lost', 'Autopilot heartbeat expired'); return }
    if (kind === 'sitl' && capabilities && t >= nextHeartbeat) {
      const heartbeat = new Uint8Array(9); heartbeat.set([6, 8, 0, 4, 3], 4); emit(0, heartbeat); nextHeartbeat = t + 1000
    }
    const p = pending
    if (!p) return
    if (t >= p.deadline) { end(new DriverProtocolError('timeout', 'Operation deadline expired; remote state may have changed')); return }
    if (t >= p.due) {
      if (p.inProgress || p.attempts >= limits.retries) { end(new DriverProtocolError('timeout', 'Response timeout; remote state may have changed')); return }
      p.attempts++; p.due = t + limits.retryMs; p.resend(p.attempts)
    }
  }
  function run<T>(key: string, operationOptions: DriverOperationOptions, setup: (o: Operation<T>) => void, discovery = false): Promise<T> {
    tick()
    if (kind !== 'sitl') return Promise.reject(new DriverProtocolError('read-only', 'Physical telemetry is receive-only'))
    if (terminal) return Promise.reject(terminal)
    if (operationOptions.signal?.aborted) return Promise.reject(new DriverProtocolError('cancelled', 'Operation cancelled before transmission'))
    if (pending) return Promise.reject(new DriverProtocolError('busy', 'One protocol transaction is allowed at a time'))
    if (!Number.isFinite(heartbeatAt) || (!discovery && !capabilities)) return Promise.reject(new DriverProtocolError('unavailable', 'Fresh matching heartbeat and capability discovery required'))
    if (quarantine.has(key)) return Promise.reject(new DriverProtocolError('ambiguous', 'Earlier uncertain transaction requires a new session'))
    return new Promise<T>((resolve, reject) => {
      const signal = operationOptions.signal
      const abort = () => {
        if (key === 'mission' && pending === p) emit(47, missionAckPayload(15, systemId, componentId))
        end(new DriverProtocolError('cancelled', 'Cancelled locally; remote state may have changed'))
      }
      const p: Pending = { keys: new Set([key]), key, deadline: lastNow + limits.operationMs, due: Infinity, attempts: 0, inProgress: false, resend: () => {}, receive: () => {}, reject, cleanup: () => signal?.removeEventListener('abort', abort) }
      pending = p
      signal?.addEventListener('abort', abort, { once: true })
      const ctx: Operation<T> = {
        phase(send) { if (pending !== p) return; p.resend = send; p.attempts = 0; p.inProgress = false; p.due = lastNow + limits.retryMs; send(0) },
        receive(callback) { p.receive = callback },
        progress() { p.inProgress = true; p.due = lastNow + limits.progressMs },
        success(value) { if (pending !== p) return; pending = null; p.cleanup(); resolve(value) },
        fail(code, message, uncertain = true) { if (pending === p) end(new DriverProtocolError(code, message), uncertain) },
      }
      try { setup(ctx) }
      catch (error) { ctx.fail('invalid-response', error instanceof Error ? error.message : String(error)) }
    })
  }
  function commandStage<T>(o: Operation<T>, command: number, params: readonly number[], accepted: (ack: CommandAcknowledgement) => void) {
    if (quarantine.has(`command:${command}`)) return o.fail('ambiguous', 'Earlier command outcome requires a new session', false)
    pending!.keys.add(`command:${command}`)
    let progress: number | null = null
    o.receive(frame => {
      if (frame.id !== 77) return
      const v = messageView(frame)
      if (v.getUint16(0, true) !== command) return
      const targetSystem = frame.payload[8] ?? 0, targetComponent = frame.payload[9] ?? 0
      if ((targetSystem !== 0 && targetSystem !== 245) || (targetComponent !== 0 && targetComponent !== 191)) return
      const result = v.getUint8(2)
      if (result === 5) { const percent = frame.payload[3] ?? 0; if (percent > 100 && percent !== 255) return o.fail('invalid-response', 'Invalid command progress'); progress = percent === 255 ? null : percent; o.progress(); return }
      if (result !== 0) { o.fail('rejected', `COMMAND_ACK rejected command ${command}, result ${result}`, false); return }
      accepted({ command, result: 0, progress, executionConfirmed: false })
    })
    o.phase(confirmation => emit(76, commandPayload(command, params, systemId, componentId, confirmation)))
  }
  const missionAddressed = (f: MavlinkFrame, at: number, missionTypeAt: number) => f.payload[at] === 245 && f.payload[at + 1] === 191 && (f.payload[missionTypeAt] ?? 0) === 0
  const requireMission = () => { if (!capabilities?.missionInt) throw new DriverProtocolError('unavailable', 'Peer has not advertised MISSION_INT') }
  const api = {
    tick,
    close: () => close(),
    transportLost: (message = 'Autopilot transport failed') => close('transport-lost', message),
    snapshot() { return { driver, kind, targetSystem: systemId, targetComponent: componentId, lastHeartbeatAtMs: heartbeatAt, capabilities: capabilities ? { ...capabilities } : null, active: pending ? { key: pending.key, attempts: pending.attempts, deadlineMs: pending.deadline, inProgress: pending.inProgress } : null, fault: terminal?.message ?? null, quarantined: [...quarantine], knownMissionCount, physicalCommands: false as const } },
    receive(frame: MavlinkFrame) {
      if (terminal || frame.systemId !== systemId || frame.componentId !== componentId) return
      const t = clock(); if (t === null) return
      if (heartbeatAt !== -Infinity && t - heartbeatAt > limits.heartbeatMs) return close('transport-lost', 'Autopilot heartbeat expired before receipt')
      if (frame.id === 0) {
        if (frame.payload[4] === driverProfiles[driver].vehicleType && frame.payload[5] === driverProfiles[driver].autopilotId) heartbeatAt = t
        return
      }
      tick()
      if (terminal || !Number.isFinite(heartbeatAt) || frame.version !== 2) return
      if (frame.id === 148 && capabilities) {
        try { const next = parseCapabilities(frame, driver); if (JSON.stringify({ ...next, bits: String(next.bits), uid: String(next.uid) }) !== JSON.stringify({ ...capabilities, bits: String(capabilities.bits), uid: String(capabilities.uid) })) close('transport-lost', 'Autopilot identity/capabilities changed') }
        catch { close('transport-lost', 'Invalid updated capabilities') }
      }
      if (completedDownload) {
        let matching = false
        try {
          matching = completedDownload.count === 0
            ? frame.id === 44 && missionAddressed(frame, 2, 4) && messageView(frame).getUint16(0, true) === 0
            : frame.id === 73 && missionAddressed(frame, 32, 37) && messageView(frame).getUint16(28, true) === completedDownload.count - 1 && JSON.stringify(parseWaypoint(frame)) === completedDownload.finalItem
        }
        catch { matching = false } // Malformed or different-plan traffic never receives a completion ACK.
        if (matching) { emit(47, missionAckPayload(0, systemId, componentId)); return }
      }
      if (!pending) return
      try { pending.receive(frame) }
      catch (error) { end(new DriverProtocolError('invalid-response', error instanceof Error ? error.message : String(error))) }
    },
    async discover(operationOptions: DriverOperationOptions = {}) {
      tick()
      if (capabilities && !terminal) return { ...capabilities }
      return run<DriverCapabilities>('command:512', operationOptions, o => {
        let acked = false, version: DriverCapabilities | null = null
        const finish = () => { if (acked && version) { capabilities = version; nextHeartbeat = lastNow; o.success({ ...version }) } }
        commandStage(o, 512, [148], () => { acked = true; finish() })
        const ackHandler = pending!.receive
        o.receive(frame => { if (frame.id === 148) { version = parseCapabilities(frame, driver); finish() } else ackHandler(frame) })
      }, true)
    },
    async sendCommand(command: number, params: readonly number[] = [], operationOptions: DriverOperationOptions = {}) {
      const parameters = [...params]; commandPayload(command, parameters, systemId, componentId)
      return run<CommandAcknowledgement>(`command:${command}`, operationOptions, o => commandStage(o, command, parameters, ack => o.success(ack)))
    },
    async setMessageRate(messageId: number, hz: number, operationOptions: DriverOperationOptions = {}) {
      if (!Number.isInteger(messageId) || messageId < 0 || messageId > 0xFFFFFF || !Number.isFinite(hz) || hz < 0.1 || hz > 50) throw new RangeError('Message rate requires an ID and 0.1..50 Hz')
      return api.sendCommand(511, [messageId, 1e6 / hz], operationOptions)
    },
    async readParameter(id: string, operationOptions: DriverOperationOptions = {}) {
      parameterId(id)
      return run<DriverParameter>(`parameter:${id}`, operationOptions, o => {
        o.receive(frame => { if (frame.id !== 22 || parameterResponseId(frame) !== id) return; const value = parseParameter(frame, capabilities!.parameterEncoding); if (value.id === id) o.success(value) })
        o.phase(() => emit(20, readParameterPayload(id, systemId, componentId)))
      })
    },
    async writeParameter(id: string, value: number, type: ParameterType, operationOptions: DriverOperationOptions = {}) {
      parameterId(id)
      if (!capabilities) throw new DriverProtocolError('unavailable', 'Capability discovery required')
      const encoding = capabilities.parameterEncoding
      parameterBytes(value, type, encoding)
      const set = setParameterPayload(id, value, type, encoding, systemId, componentId), expected = type === 9 ? Math.fround(value) : value
      return run<DriverParameter>(`parameter:${id}`, operationOptions, o => {
        let writing = false
        o.receive(frame => {
          if (frame.id !== 22 || parameterResponseId(frame) !== id) return
          const current = parseParameter(frame, encoding)
          if (current.id !== id) return
          if (current.type !== type) return o.fail('rejected', 'Parameter metadata type does not match requested write', false)
          if (!writing) {
            writing = true
            // Explicit readback also supports ArduPilot versions that omit a PARAM_SET echo.
            o.phase(() => { emit(23, set); emit(20, readParameterPayload(id, systemId, componentId)) })
          }
          else if (current.value === expected) o.success(current)
        })
        o.phase(() => emit(20, readParameterPayload(id, systemId, componentId)))
      })
    },
    async uploadMission(items: readonly MissionWaypoint[], operationOptions: DriverOperationOptions = {}) {
      requireMission()
      if (!Array.isArray(items) || items.length > limits.missionItems) throw new RangeError('Mission exceeds 128 waypoint budget')
      const waypoints = items.map(normalizeWaypoint)
      return run<{ count: number, accepted: true }>('mission', operationOptions, o => {
        knownMissionCount = null; completedDownload = null
        let next = 0
        o.receive(frame => {
          const v = messageView(frame)
          if ((frame.id === 51 || frame.id === 40) && missionAddressed(frame, 2, 4)) {
            const seq = v.getUint16(0, true)
            if (seq >= waypoints.length || seq > next) { emit(47, missionAckPayload(13, systemId, componentId)); o.fail('invalid-response', 'Out-of-order mission upload request'); return }
            if (seq === next) { next++; o.phase(() => emit(73, waypointPayload(waypoints[seq]!, seq, systemId, componentId))) }
            else emit(73, waypointPayload(waypoints[seq]!, seq, systemId, componentId))
          }
          if (frame.id === 47 && missionAddressed(frame, 0, 3)) {
            if (frame.payload[2] !== 0) return o.fail('rejected', `MISSION_ACK result ${frame.payload[2]}`)
            if (next !== waypoints.length) return // A premature ACK cannot commit an incomplete upload.
            knownMissionCount = next; o.success({ count: next, accepted: true })
          }
        })
        o.phase(() => emit(44, missionCountPayload(waypoints.length, systemId, componentId)))
      })
    },
    async downloadMission(operationOptions: DriverOperationOptions = {}) {
      requireMission()
      return run<Required<MissionWaypoint>[]>('mission', operationOptions, o => {
        knownMissionCount = null; completedDownload = null
        let count: number | null = null
        const items: Required<MissionWaypoint>[] = []
        const request = () => emit(51, missionCountPayload(items.length, systemId, componentId))
        const finish = () => { completedDownload = { untilMs: lastNow + limits.completionMs, count: items.length, finalItem: items.length ? JSON.stringify(items.at(-1)) : null }; emit(47, missionAckPayload(0, systemId, componentId)); knownMissionCount = items.length; o.success(items) }
        o.receive(frame => {
          const v = messageView(frame)
          if (frame.id === 47 && missionAddressed(frame, 0, 3) && frame.payload[2] !== 0) return o.fail('rejected', `MISSION_ACK result ${frame.payload[2]}`)
          if (frame.id === 44 && missionAddressed(frame, 2, 4)) {
            const n = v.getUint16(0, true)
            if (n > limits.missionItems || (count !== null && n !== count)) return o.fail('invalid-response', 'Mission count invalid or changed')
            if (count !== null) return
            count = n
            if (count === 0) finish(); else o.phase(request)
          }
          if (frame.id === 73 && missionAddressed(frame, 32, 37) && count !== null) {
            const seq = v.getUint16(28, true)
            if (seq >= count) return o.fail('invalid-response', 'Mission item outside declared count')
            if (seq > items.length) return
            const item = parseWaypoint(frame)
            if (seq < items.length) { if (JSON.stringify(item) !== JSON.stringify(items[seq])) o.fail('invalid-response', 'Mission changed during download'); return }
            items.push(item)
            if (items.length === count) finish(); else o.phase(request)
          }
        })
        o.phase(() => emit(43, new Uint8Array([systemId, componentId, 0])))
      })
    },
    async resumeMission(index: number, operationOptions: DriverOperationOptions = {}) {
      requireMission()
      if (!Number.isInteger(index) || index < 0 || knownMissionCount === null || index >= knownMissionCount) throw new RangeError('Resume requires a valid index in a mission transferred this session')
      return run<{ index: number, accepted: true, executionConfirmed: false }>('mission', operationOptions, o => {
        let acked = false, current = false, resumed = false
        const proceed = () => { if (acked && current && !resumed) { resumed = true; commandStage(o, 193, [1], () => o.success({ index, accepted: true, executionConfirmed: false })) } }
        commandStage(o, 224, [index, 0], () => { acked = true; proceed() })
        const handleAck = pending!.receive
        o.receive(frame => { if (frame.id === 42 && messageView(frame).getUint16(0, true) === index) { current = true; proceed() } else handleAck(frame) })
      })
    },
  }
  return api
}
export type AutopilotProtocol = ReturnType<typeof createDriverProtocol>
