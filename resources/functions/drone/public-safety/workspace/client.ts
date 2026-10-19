import type { BroadcastStreamClientOptions } from '@stacksjs/stx/composables/use-broadcast-stream'
import type { HandoverDecisionInput, HandoverOfferInput } from '../access/handover-types'
import type { ObservationProjection, RecordPage, ReviewProjection, SourceRead } from '../access/record-types'
import type { AssignableIncidentRole } from '../access/types'
import type { WorkspaceOptions, WorkspaceRecipient, WorkspaceSnapshot } from './types'
import { openIncidentExecution } from '../execution/client'
import { useBroadcastStream } from '@stacksjs/stx/composables/use-broadcast-stream'

export interface WorkspaceClientView {
  status: 'disconnected' | 'connecting' | 'synchronizing' | 'current' | 'reconnecting' | 'refused'
  snapshot: WorkspaceSnapshot | null
  source: SourceRead | null
  reviewTarget: number | null
  reviewObservation: ObservationProjection | null
  reviews: RecordPage<ReviewProjection> | null
  busy: boolean
  error: string
  notice: string
  confirmationRequired: boolean
  canRetryHandover: boolean
  reset: number
}
interface WorkspaceClientOptions {
  request?: (path: string, init?: RequestInit) => Promise<Response>
  stream?: (options: BroadcastStreamClientOptions) => { close: () => void }
  refreshMs?: number
}
export interface ObservationDraft { captureId: string, modality: 'visible' | 'thermal', x: number, y: number, note: string, uncertaintyNote: string }
export interface ReviewBinding { observationId: number, sourceDigest: string, previousReviewId: number | null }
export interface ReviewDraft { disposition: 'unresolved' | 'supported-by-source' | 'not-supported-by-source', note: string }
class WireFailure extends Error { constructor(readonly status: number) { super('Incident request refused') } }

/** Browser-only screen model. Credentials belong exclusively to the active request closure. */
export function openIncidentWorkspace(settings: WorkspaceClientOptions = {}) {
  const transport = settings.request ?? ((path: string, init?: RequestInit) => fetch(path, init))
  const createStream = settings.stream ?? useBroadcastStream
  const listeners = new Set<(view: WorkspaceClientView) => void>()
  let view: WorkspaceClientView = { status: 'disconnected', snapshot: null, source: null, reviewTarget: null, reviewObservation: null, reviews: null, busy: false, error: '', notice: '', confirmationRequired: false, canRetryHandover: false, reset: 0 }
  let credential: string | null = null, incident = '', identity = 0, activity = 0, scope: string | null = null, accountId: number | null = null
  let stream: { close: () => void } | null = null, connected = false, dirty = false
  let reading: Promise<void> | null = null, options: WorkspaceOptions = { limit: 30 }
  let poll: ReturnType<typeof setInterval> | undefined, expiry: ReturnType<typeof setTimeout> | undefined
  let retry: { scope: string, path: string, body: HandoverOfferInput | HandoverDecisionInput } | null = null
  const pending = new Set<AbortController>()
  let reviewSelection = 0, authority = '', fieldRefusal = false
  const executionClient = openIncidentExecution({ endpoint: () => `${base()}/workspace/execution`, request, stream: settings.stream, refreshWorkspace: refresh,
    async sourceExists(digest) {
      const generation = identity, binding = scope
      const checked = await json<WorkspaceSnapshot>(`${base()}/workspace?sourceDigest=${digest}&limit=1`)
      return generation === identity && binding === scope && checked.scope === binding && checked.viewer.accountId === accountId && checked.profile === 'incident-workspace-v1' && checked.selected?.source.digest === digest
    },
  })
  const publish = (patch: Partial<WorkspaceClientView>) => {
    view = { ...view, ...patch }
    executionClient.sync({ available: view.status === 'current' && !!view.snapshot && !!view.snapshot.actions.canRegisterSource, scope, canMutate: !!view.snapshot?.actions.canRegisterSource, version: view.snapshot?.incident.version ?? 0, catalogDigests: view.snapshot?.sources.entries.map(source => source.digest) ?? [] })
    for (const listener of listeners) listener(view)
  }
  const base = () => `/api/public-safety/incidents/${incident}`
  function discard(clearDrafts = true) {
    if (clearDrafts) { fieldRefusal = false; executionClient.clear() }
    activity++
    reviewSelection++
    for (const request of pending) request.abort()
    pending.clear()
    clearTimeout(expiry)
    retry = null
    publish({ snapshot: null, source: null, reviewTarget: clearDrafts ? null : view.reviewTarget, reviewObservation: null, reviews: null, busy: false, confirmationRequired: clearDrafts ? false : view.confirmationRequired, canRetryHandover: false, reset: view.reset + (clearDrafts ? 1 : 0) })
  }
  function disconnect(message = '', refused = false) {
    identity++; credential = null; connected = false; dirty = false; scope = null; accountId = null; authority = ''
    clearInterval(poll); clearTimeout(expiry)
    const previous = stream; stream = null; previous?.close()
    reading = null; options = { limit: 30 }; discard()
    publish({ status: refused ? 'refused' : 'disconnected', error: message, notice: '' })
  }
  function refused(status: number) {
    disconnect(status === 401 ? 'Your credential is unavailable. Connect again with a current personal credential.' : 'Incident access is unavailable. Private content has been cleared.', true)
  }
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = credential, generation = identity
    if (!token || !(path === base() || path.startsWith(`${base()}/`))) throw new Error('No current incident connection')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await transport(path, { ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'same-origin' })
    if (generation === identity && [401, 403, 404].includes(response.status)) refused(response.status)
    return response
  }
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    pending.add(controller)
    try {
      const response = await request(path, { ...init, signal: controller.signal })
      if (!response.ok) throw new WireFailure(response.status)
      return await response.json() as T
    }
    finally { pending.delete(controller) }
  }
  function deadline(snapshot: WorkspaceSnapshot) {
    clearTimeout(expiry)
    const delay = Date.parse(snapshot.availableUntil) - Date.now()
    if (!Number.isFinite(delay) || delay <= 0) throw new Error('Incident content has expired')
    expiry = setTimeout(() => {
      discard()
      publish({ status: 'synchronizing', notice: 'Availability changed. Checking current access.' })
      void refresh()
    }, Math.min(delay, 2147483647))
  }
  function query() {
    const parameters = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) if (value !== undefined) parameters.set(key, String(value))
    return `${base()}/workspace?${parameters}`
  }
  async function refresh(): Promise<void> {
    if (!credential || !connected) return
    dirty = true
    if (reading) return reading
    const generation = identity
    const operation = (async () => {
      while (dirty && generation === identity && credential && connected) {
        dirty = false
        const version = activity
        try {
          const snapshot = await json<WorkspaceSnapshot>(query())
          if (generation !== identity || version !== activity || !connected) continue
          if (snapshot.profile !== 'incident-workspace-v1' || snapshot.incident.key !== incident || !Number.isSafeInteger(snapshot.viewer.accountId) || !snapshot.scope) throw new Error('Invalid workspace response')
          if (scope !== null && scope !== snapshot.scope || accountId !== null && accountId !== snapshot.viewer.accountId) {
            disconnect('Incident scope or account changed. Connect again to review its current identity.', true)
            return
          }
          const nextAuthority = JSON.stringify([snapshot.incident.membership, snapshot.incident.status, snapshot.viewer.canCoordinate, snapshot.handover.assignment, snapshot.actions])
          if (authority && authority !== nextAuthority) discard()
          authority = nextAuthority
          scope = snapshot.scope; accountId = snapshot.viewer.accountId
          deadline(snapshot)
          publish({ snapshot, status: 'current', error: view.confirmationRequired || fieldRefusal ? view.error : '', notice: view.confirmationRequired ? view.notice : '' })
        }
        catch (failure) {
          if (generation !== identity || version !== activity) continue
          if (failure instanceof WireFailure && [401, 403, 404].includes(failure.status)) return
          if (failure instanceof WireFailure && [409, 422].includes(failure.status)) { refused(failure.status); return }
          discard()
          publish({ status: 'reconnecting', error: 'The workspace could not be refreshed. Private content has been cleared.' })
          return
        }
      }
    })()
    reading = operation
    try { await operation }
    finally { if (reading === operation) reading = null }
  }
  function connect(key: string, token: string): void {
    disconnect()
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !token || token.length > 4096 || /[\r\n]/.test(token)) { publish({ error: 'Enter a valid incident key and personal credential.' }); return }
    incident = key; credential = token; const generation = identity
    publish({ status: 'connecting', error: '' })
    stream = createStream({
      endpoint: `${base()}/workspace/events`, request,
      onConnected() { if (generation === identity) { connected = true; publish({ status: 'synchronizing' }); void refresh() } },
      onMessage(frame) { if (generation === identity && frame.event === 'refresh') void refresh() },
      onStatus(value) {
        if (generation !== identity) return
        connected = value
        if (!value) { discard(false); publish({ status: 'reconnecting', notice: 'Connection lost. Waiting for a fresh authorized snapshot.' }) }
      },
    })
    poll = setInterval(() => { void refresh() }, settings.refreshMs ?? 10000)
  }
  function selectSource(digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest) || !view.snapshot?.sources.entries.some(source => source.digest === digest)) return
    fieldRefusal = false
    activity++; options = { ...options, sourceDigest: digest, contextCursor: undefined }
    retry = null
    publish({ snapshot: null, source: null, reviewTarget: null, reviewObservation: null, reviews: null, confirmationRequired: false, canRetryHandover: false, reset: view.reset + 1, status: 'synchronizing' })
    void refresh()
  }
  function page(kind: 'sources' | 'context' | 'members' | 'handover', first = false) {
    const snapshot = view.snapshot
    if (!snapshot || view.busy) return
    if (kind === 'sources') options.sourcesAfterSequence = first ? undefined : snapshot.sources.cursor
    if (kind === 'context') options.contextCursor = first ? undefined : snapshot.selected?.cursor ?? undefined
    if (kind === 'members') options.membersAfterUserId = first ? undefined : snapshot.recipients?.cursor
    if (kind === 'handover') options.handoverAfterSequence = first ? undefined : snapshot.handover.briefing?.cursor
    void refresh()
  }
  function selectOffer(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) return
    fieldRefusal = false
    activity++; options = { ...options, offerKey: key, handoverAfterSequence: undefined }
    retry = null
    publish({ confirmationRequired: false, canRetryHandover: false, reset: view.reset + 1, snapshot: null, status: 'synchronizing' })
    void refresh()
  }
  async function loadSource(): Promise<void> {
    const digest = view.snapshot?.selected?.source.digest, generation = identity, version = activity
    if (!digest || view.status !== 'current') return
    try {
      const source = await json<SourceRead>(`${base()}/sources/${digest}`)
      if (generation === identity && version === activity && view.snapshot?.selected?.source.digest === digest) publish({ source })
    }
    catch { if (generation === identity && version === activity) publish({ error: 'Source content is unavailable. No previous image is used.', source: null }) }
  }
  async function loadReviews(observationId: number, after = 0): Promise<void> {
    const generation = identity, version = activity, digest = view.snapshot?.selected?.source.digest, selection = ++reviewSelection
    if (!digest || !Number.isSafeInteger(observationId) || observationId < 1) return
    publish({ reviewTarget: observationId, reviewObservation: view.reviewTarget === observationId ? view.reviewObservation : null, reviews: null })
    try {
      const [observation, reviews] = await Promise.all([
        json<ObservationProjection>(`${base()}/observations/${observationId}`),
        json<RecordPage<ReviewProjection>>(`${base()}/observations/${observationId}/reviews?after=${after}&limit=100`),
      ])
      if (generation !== identity || version !== activity || selection !== reviewSelection) return
      if (observation.sourceDigest !== digest) throw new Error('Observation source differs')
      publish({ reviewObservation: observation, reviews })
    }
    catch { if (generation === identity && version === activity && selection === reviewSelection) publish({ error: 'The observation review context is unavailable.', reviewObservation: null, reviews: null }) }
  }
  function ready() { return view.status === 'current' && !!view.snapshot && !view.busy && !view.confirmationRequired }
  async function command(path: string, body: object, handover = false): Promise<boolean> {
    if (!ready()) return false
    const generation = identity, version = activity, binding = scope
    fieldRefusal = false
    publish({ busy: true, error: '', notice: '' })
    if (handover && binding) retry = { scope: binding, path, body: body as HandoverOfferInput | HandoverDecisionInput }
    try {
      await json(path, { method: 'POST', body: JSON.stringify(body) })
      if (generation !== identity || version !== activity) return false
      retry = null
      options.contextCursor = undefined
      publish({ busy: false, canRetryHandover: false, notice: 'Saved. Reading current responsibility and records.' })
      await refresh()
      return generation === identity && version === activity
    }
    catch (failure) {
      if (generation !== identity || version !== activity) return false
      const ambiguous = !(failure instanceof WireFailure) || failure.status >= 500
      fieldRefusal = failure instanceof WireFailure && failure.status === 422
      if (!ambiguous) retry = null
      publish({ busy: false, confirmationRequired: ambiguous || failure instanceof WireFailure && failure.status === 409, canRetryHandover: ambiguous && handover, error: failure instanceof WireFailure && failure.status === 422 ? 'The fields were refused. Check your declaration.' : failure instanceof WireFailure && failure.status === 409 ? 'The context changed. Review fresh records before explicitly submitting again.' : 'Outcome unknown. Inspect current records before making another declaration.', notice: '' })
      await refresh()
      return false
    }
  }
  async function observe(draft: ObservationDraft) {
    const snapshot = view.snapshot
    if (!snapshot?.actions.canObserve || !snapshot.selected || !view.source) return false
    return command(`${base()}/observations`, { expectedVersion: snapshot.incident.version, sourceDigest: snapshot.selected.source.digest, captureId: draft.captureId, modality: draft.modality, pixel: { x: draft.x, y: draft.y }, note: draft.note, uncertaintyNote: draft.uncertaintyNote })
  }
  function reviewBinding(): ReviewBinding | null {
    const observation = view.reviewObservation, reviews = view.reviews
    if (!observation || !reviews || reviews.hasMore || observation.sourceDigest !== view.snapshot?.selected?.source.digest) return null
    return { observationId: observation.id, sourceDigest: observation.sourceDigest, previousReviewId: reviews.entries.at(-1)?.id ?? null }
  }
  async function review(draft: ReviewDraft, binding: ReviewBinding | null) {
    const snapshot = view.snapshot, observation = view.reviewObservation, reviews = view.reviews
    if (!snapshot?.actions.canReview || !observation || !reviews || reviews.hasMore) return false
    const current = reviewBinding()
    if (!binding || !current || binding.observationId !== current.observationId || binding.sourceDigest !== current.sourceDigest || binding.previousReviewId !== current.previousReviewId) {
      publish({ confirmationRequired: true, error: 'Review target or head changed. Read the current original and reviews, then explicitly bind your draft again.' })
      return false
    }
    return command(`${base()}/observations/${observation.id}/reviews`, { expectedVersion: snapshot.incident.version, sourceDigest: observation.sourceDigest, previousReviewId: reviews.entries.at(-1)?.id ?? null, disposition: draft.disposition, note: draft.note })
  }
  async function offer(selectedRecipient: WorkspaceRecipient, outgoingRole: AssignableIncidentRole, expiresInSeconds: number) {
    const snapshot = view.snapshot, recipient = snapshot?.recipients?.entries.find(member => member.userId === selectedRecipient.userId && member.role === selectedRecipient.role && member.membershipVersion === selectedRecipient.membershipVersion)
    if (!snapshot?.handover.actionability.canOffer || !snapshot.selected || !recipient) return false
    const body: HandoverOfferInput = { requestId: crypto.randomUUID(), assignment: snapshot.handover.assignment, recipientUserId: recipient.userId, recipientMembershipVersion: recipient.membershipVersion, sourceDigest: snapshot.selected.source.digest, outgoingRole, expiresInSeconds }
    return command(`${base()}/handover/offer`, body, true)
  }
  async function decide(decision: 'accept' | 'decline' | 'cancel', acknowledged = false) {
    const desk = view.snapshot?.handover
    if (!desk?.offer || !desk.actionability[decision === 'accept' ? 'canAccept' : decision === 'decline' ? 'canDecline' : 'canCancel']) return false
    if (decision === 'accept' && (!acknowledged || !desk.briefing)) return false
    options.offerKey = desk.offer.key
    const body: HandoverDecisionInput = decision === 'accept' ? { requestId: crypto.randomUUID(), offerKey: desk.offer.key, decision, acknowledgement: desk.briefing!.acknowledgementRequired } : { requestId: crypto.randomUUID(), offerKey: desk.offer.key, decision }
    return command(`${base()}/handover/decision`, body, true)
  }
  async function retryHandover() {
    const previous = retry
    if (!previous || previous.scope !== scope || view.status !== 'current' || view.busy) return false
    publish({ confirmationRequired: false })
    return command(previous.path, previous.body, true)
  }
  return {
    get: () => view,
    subscribe(listener: (value: WorkspaceClientView) => void) { listeners.add(listener); listener(view); return () => listeners.delete(listener) },
    execution: executionClient,
    connect, disconnect, refresh, selectSource, selectOffer, page, loadSource, loadReviews, observe, review, reviewBinding, offer, decide, retryHandover,
    confirmCurrentContext() { if (view.status === 'current') publish({ confirmationRequired: false, error: '', notice: 'Current context reviewed. Submission requires your explicit action.' }) },
    close() { disconnect(); executionClient.close(); listeners.clear() },
  }
}
