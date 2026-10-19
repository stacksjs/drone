import type { BroadcastStreamClientOptions } from '@stacksjs/stx/composables/use-broadcast-stream'
import type { PublicSafetyScenario } from '../runtime-types'
import type { ExecutionView } from './types'
import { useBroadcastStream } from '@stacksjs/stx/composables/use-broadcast-stream'

export interface ExecutionClientContext { available: boolean, scope: string | null, canMutate: boolean, version: number, catalogDigests: string[] }
export interface ExecutionClientView {
  execution: ExecutionView | null
  hasReservation: boolean
  busy: boolean
  connected: boolean
  unknownStart: boolean
  unknownAdmission: boolean
  sourceExists: boolean
  error: string
  notice: string
}
interface ExecutionClientOptions {
  endpoint: () => string
  request: (path: string, init?: RequestInit) => Promise<Response>
  stream?: (options: BroadcastStreamClientOptions) => { close: () => void }
  refreshWorkspace: () => Promise<void>
  sourceExists?: (digest: string) => Promise<boolean>
}
class RequestFailure extends Error { constructor(readonly status: number) { super('Execution request refused') } }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = /^[a-f0-9]{64}$/
const live = (value: ExecutionView) => ['waiting-for-consumer', 'running', 'stopping'].includes(value.phase)

/** Browser-only volatile caller. The parent owns credentials and native authority. */
export function openIncidentExecution(settings: ExecutionClientOptions) {
  const createStream = settings.stream ?? useBroadcastStream
  const listeners = new Set<(value: ExecutionClientView) => void>()
  let view: ExecutionClientView = { execution: null, hasReservation: false, busy: false, connected: false, unknownStart: false, unknownAdmission: false, sourceExists: false, error: '', notice: '' }
  let context: ExecutionClientContext = { available: false, scope: null, canMutate: false, version: 0, catalogDigests: [] }
  let generation = 0, streamGeneration = 0, intent: string | null = null, execution: string | null = null
  let stream: { close: () => void } | null = null, streamFor: string | null = null, reading: Promise<void> | null = null
  let expiry: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<AbortController>()
  const publish = (patch: Partial<ExecutionClientView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(view) }
  function closeStream() {
    // Invalidate callbacks before native close synchronously emits onStatus(false).
    streamGeneration++
    const previous = stream; stream = null; streamFor = null
    previous?.close()
  }
  function conceal() {
    generation++
    closeStream(); clearTimeout(expiry)
    for (const controller of pending) controller.abort()
    pending.clear(); reading = null
    publish({ execution: null, busy: false, connected: false, sourceExists: false })
  }
  function clear() {
    intent = null; execution = null
    conceal()
    publish({ hasReservation: false, unknownStart: false, unknownAdmission: false, error: '', notice: '' })
  }
  function valid(value: ExecutionView): boolean {
    return !!value && uuid.test(value.execution) && uuid.test(value.intent) && value.scope === context.scope && value.profile === 'owned-public-safety-collection-v1'
      && value.identityAuthenticated === true && value.sourceIdentityAuthenticated === false && value.physicalFlightEnabled === false && value.physicalThermalVerified === false
      && ['waiting-for-consumer', 'running', 'stopping', 'completed', 'canceled', 'failed', 'discarded'].includes(value.phase)
      && (!value.completion || digest.test(value.completion.digest))
      && (!intent || value.intent === intent) && (!execution || value.execution === execution)
  }
  function accept(value: ExecutionView) {
    if (!valid(value)) throw new Error('Execution binding changed')
    const delay = Date.parse(value.availableUntil) - Date.now()
    if (!Number.isFinite(delay) || delay <= 0) throw new Error('Execution availability expired')
    intent = value.intent; execution = value.execution
    clearTimeout(expiry)
    const currentGeneration = generation
    expiry = setTimeout(() => {
      if (currentGeneration !== generation) return
      conceal()
      publish({ notice: 'Execution availability changed. Read current status; missing metadata is unknown history.' })
    }, Math.min(delay, 2147483647))
    publish({ execution: value, hasReservation: true, unknownStart: false, sourceExists: !!value.completion && context.catalogDigests.includes(value.completion.digest) })
    if (live(value)) attach(value)
    else closeStream()
  }
  function attach(value: ExecutionView) {
    if (streamFor === value.execution || !context.available) return
    closeStream()
    const currentGeneration = generation, currentStream = streamGeneration, currentScope = context.scope, currentExecution = value.execution
    streamFor = value.execution
    const current = () => currentGeneration === generation && currentStream === streamGeneration && context.available && context.scope === currentScope && execution === currentExecution
    const created = createStream({
      endpoint: `${settings.endpoint()}/${value.execution}/events?scope=${currentScope}`, request: settings.request,
      onConnected() { if (current()) publish({ connected: true, notice: '' }) },
      onMessage(frame) {
        if (!current() || frame.event !== 'execution') return
        try { accept(frame.data as ExecutionView) }
        catch { conceal(); publish({ error: 'Execution progress is unavailable. Read current status before continuing.' }) }
      },
      onStatus(connected) { if (current()) publish({ connected, notice: connected ? '' : 'Progress connection renewed through GET only. No simulation is restarted.' }) },
    })
    if (current()) stream = created
    else created.close()
  }
  async function json<T>(path: string, body?: object): Promise<T> {
    const controller = new AbortController(); pending.add(controller)
    try {
      const response = await settings.request(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: controller.signal })
      if (!response.ok) throw new RequestFailure(response.status)
      return await response.json() as T
    }
    finally { pending.delete(controller) }
  }
  function beginMutation() {
    generation++
    closeStream(); reading = null
    for (const controller of pending) controller.abort()
    pending.clear()
  }
  function current(version: number, scope: string | null) { return version === generation && context.available && scope === context.scope }
  async function refresh(): Promise<void> {
    if (!context.available || !context.scope || view.busy) return
    if (reading) return reading
    const version = generation, scope = context.scope
    const operation = (async () => {
      try {
        const value = await json<ExecutionView | null>(`${settings.endpoint()}?scope=${scope}`)
        if (!current(version, scope)) return
        if (value) {
          const reconcilingStart = view.unknownStart
          accept(value)
          if (reconcilingStart) publish({ error: '', notice: 'Current execution matches the original start intent. No start request was retried.' })
        }
        else {
          closeStream(); clearTimeout(expiry)
          publish({ execution: null, connected: false, notice: intent ? 'No current reservation was found. Earlier execution history is unknown; the start request is not retried.' : 'No current owned execution. Process-local metadata does not establish earlier history.' })
        }
      }
      catch {
        if (!current(version, scope)) return
        conceal(); publish({ error: 'Execution status could not be verified. Private progress has been cleared.' })
      }
    })()
    reading = operation
    try { await operation }
    finally { if (reading === operation) reading = null }
  }
  function sync(next: ExecutionClientContext) {
    const prior = context
    context = next
    if (prior.scope !== next.scope) clear()
    if (!next.available) { if (prior.available) conceal(); return }
    const completion = view.execution?.completion
    if (completion) publish({ sourceExists: next.catalogDigests.includes(completion.digest) })
    if (!prior.available || prior.scope !== next.scope) void refresh()
  }
  async function start(scenario: PublicSafetyScenario, seconds: number): Promise<boolean> {
    if (!context.available || !context.canMutate || !context.scope || view.busy || execution || intent || view.unknownStart) return false
    if (!Number.isInteger(seconds) || seconds < 8 || seconds > 120) { publish({ error: 'Requested seconds must be a whole number from 8 through 120.' }); return false }
    beginMutation()
    const version = generation, scope = context.scope
    intent = crypto.randomUUID()
    publish({ hasReservation: true, busy: true, error: '', notice: '' })
    try {
      const value = await json<ExecutionView>(settings.endpoint(), { intent, scope, scenario, seconds })
      if (!current(version, scope)) return false
      accept(value); publish({ busy: false })
      return true
    }
    catch (failure) {
      if (!current(version, scope)) return false
      const unknown = !(failure instanceof RequestFailure) || failure.status >= 500
      if (!unknown) intent = null
      publish({ hasReservation: !!intent, busy: false, unknownStart: unknown, error: unknown ? 'Outcome unknown. Read current execution status to reconcile the original intent. The start request will not be retried.' : 'Execution start was refused. Review current access, availability and fields.' })
      return false
    }
  }
  async function stop(): Promise<boolean> {
    const value = view.execution
    if (!context.available || !context.canMutate || !context.scope || view.busy || !value) return false
    beginMutation()
    const version = generation, scope = context.scope
    publish({ busy: true, error: '', notice: '' })
    try {
      const result = await json<ExecutionView>(`${settings.endpoint()}/close`, { execution: value.execution, scope })
      if (!current(version, scope)) return false
      if (result.phase === 'discarded' && result.producer === 'finished') {
        if (!valid(result)) throw new Error('Execution binding changed')
        clear()
        publish({ notice: 'Temporary result discarded. A new run requires a new explicit start.' })
      }
      else { accept(result); publish({ busy: false, notice: 'Close requested. Producer status distinguishes finished work from an unconfirmed stop.' }) }
      return true
    }
    catch {
      if (current(version, scope)) publish({ busy: false, error: 'Close outcome unknown. Read current status before making another request.' })
      return false
    }
  }
  async function reconcileSource(value: ExecutionView, version: number, scope: string) {
    const hash = value.completion?.digest
    if (!hash || !settings.sourceExists) return
    const exists = await settings.sourceExists(hash)
    if (current(version, scope) && view.execution?.execution === value.execution) publish({ sourceExists: exists })
  }
  async function admit(): Promise<boolean> {
    const value = view.execution, completion = value?.completion, scope = context.scope
    if (!context.available || !context.canMutate || !scope || view.busy || value?.phase !== 'completed' || !completion || value.admission !== 'unsubmitted' || view.unknownAdmission || view.sourceExists) return false
    beginMutation()
    const version = generation
    publish({ busy: true, error: '', notice: '' })
    try {
      // Admission takes the revision read for this explicit click, never the run's start revision.
      await settings.refreshWorkspace()
      if (!current(version, scope) || !context.canMutate || view.execution?.execution !== value.execution) return false
      await json(`${settings.endpoint()}/admission`, { execution: value.execution, scope, digest: completion.digest, expectedVersion: context.version })
      if (!current(version, scope)) return false
      publish({ busy: false, notice: 'Admission response received. Read the current source catalog; source selection remains explicit.' })
      await settings.refreshWorkspace(); await refresh()
      await reconcileSource(value, version, scope)
      return current(version, scope)
    }
    catch (failure) {
      if (!current(version, scope)) return false
      const unknown = !(failure instanceof RequestFailure) || failure.status >= 500
      publish({ busy: false, unknownAdmission: unknown, error: unknown ? 'Admission outcome unknown. Read the source catalog to check this digest. Existence does not establish which request inserted it. No automatic retry is made.' : 'Admission was refused. Review the fresh incident version and source catalog before explicitly deciding again.' })
      await settings.refreshWorkspace()
      if (unknown) { try { await reconcileSource(value, version, scope) } catch {} }
      return false
    }
    finally { if (current(version, scope) && view.busy) publish({ busy: false }) }
  }
  return {
    get: () => view,
    subscribe(listener: (value: ExecutionClientView) => void) { listeners.add(listener); listener(view); return () => listeners.delete(listener) },
    sync, clear, refresh, start, stop, admit,
    close() { context = { ...context, available: false }; clear(); listeners.clear() },
  }
}
