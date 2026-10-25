/* eslint-disable */
/**
 * Stacks API client, generated from the OpenAPI document.
 *
 * Do not edit. Run `buddy generate:openapi` to rebuild it from the routes.
 *
 * No imports and no dependencies: copy this file anywhere that has `fetch`.
 */

/** Every call answers with one of these. Nothing here throws for a 4xx. */
export type ApiResult<T> =
  | { ok: true, status: number, data: T, headers: Headers }
  | { ok: false, status: number, error: unknown, headers: Headers }

export interface ClientConfig {
  /** Where the API lives, e.g. `https://example.com`. No trailing slash needed. */
  baseUrl: string
  /** Sent as `Authorization: Bearer …` when present. */
  token?: string
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** Swap in a different fetch - a test double, or one that retries. */
  fetch?: typeof fetch
}

export interface RequestOptions {
  /** Abort in flight. */
  signal?: AbortSignal
  /** Headers for this call only, merged over the client's. */
  headers?: Record<string, string>
}

function buildUrl(config: ClientConfig, route: string, input: Record<string, unknown>, query: string[]): string {
  // Path parameters are substituted, never appended: a `{id}` left in the URL
  // is a 404 whose message is about the literal string "{id}".
  const filled = route.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(input[key] ?? '')))
  const url = new URL(filled.replace(/^\/+/, '/'), config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)

  for (const key of query) {
    const value = input[key]
    // Absent means absent. Sending `?path=` asks for the file called empty
    // string, which is a different question from not filtering.
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

async function request<T>(
  config: ClientConfig,
  method: string,
  route: string,
  input: Record<string, unknown>,
  query: string[],
  hasBody: boolean,
  options?: RequestOptions,
): Promise<ApiResult<T>> {
  const call = config.fetch ?? fetch
  const url = buildUrl(config, route, input, query)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.headers ?? {}),
    ...(options?.headers ?? {}),
  }
  if (config.token) headers.Authorization = `Bearer ${config.token}`

  const body = hasBody && input.body !== undefined ? JSON.stringify(input.body) : undefined
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await call(url, { method, headers, body, signal: options?.signal })

  const text = await response.text()
  let parsed: unknown = text
  if (text.length) {
    // A non-JSON body is kept verbatim rather than replaced with a parse error.
    // An endpoint that answered with HTML is worth seeing.
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  else {
    parsed = null
  }

  return response.ok
    ? { ok: true, status: response.status, data: parsed as T, headers: response.headers }
    : { ok: false, status: response.status, error: parsed, headers: response.headers }
}

export function createClient(config: ClientConfig) {
  return {
    /** The configuration in use, so a caller can rebuild a variant of it. */
    config,

  /**
   * POST /api/camera/command
   */
  postCameraCommand(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/camera/command", {}, [], false, options)
  },

  /**
   * GET /api/camera/state
   */
  getCameraState(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/camera/state", {}, [], false, options)
  },

  /**
   * GET /api/drone/capabilities
   */
  getDroneCapabilities(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/drone/capabilities", {}, [], false, options)
  },

  /**
   * POST /api/patrol/reviews
   */
  postPatrolReviews(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/patrol/reviews", {}, [], false, options)
  },

  /**
   * GET /api/patrol/reviews/{schedule}
   */
  getPatrolReviewsSchedule(input: { "schedule": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/patrol/reviews/{schedule}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/patrol/reviews/{schedule}/occurrences/{due}/consume
   */
  postPatrolReviewsScheduleOccurrencesDueConsume(input: { "schedule": string; "due": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/patrol/reviews/{schedule}/occurrences/{due}/consume", input ?? {}, [], false, options)
  },

  /**
   * POST /api/patrol/reviews/{schedule}/occurrences/{due}/decision
   */
  postPatrolReviewsScheduleOccurrencesDueDecision(input: { "schedule": string; "due": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/patrol/reviews/{schedule}/occurrences/{due}/decision", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents
   */
  postPublicSafetyIncidents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents", {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}
   */
  getPublicSafetyIncidentsIncident(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/audit
   */
  getPublicSafetyIncidentsIncidentAudit(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/audit", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/close
   */
  postPublicSafetyIncidentsIncidentClose(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/close", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/handover
   */
  getPublicSafetyIncidentsIncidentHandover(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/handover", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/handover/decision
   */
  postPublicSafetyIncidentsIncidentHandoverDecision(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/handover/decision", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/handover/offer
   */
  postPublicSafetyIncidentsIncidentHandoverOffer(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/handover/offer", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/managed-artifacts
   */
  getPublicSafetyIncidentsIncidentManagedArtifacts(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/managed-artifacts", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/managed-artifacts
   */
  postPublicSafetyIncidentsIncidentManagedArtifacts(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/managed-artifacts", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/managed-artifacts/{artifact}
   */
  getPublicSafetyIncidentsIncidentManagedArtifactsArtifact(input: { "incident": string; "artifact": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/managed-artifacts/{artifact}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/events
   */
  getPublicSafetyIncidentsIncidentManagedArtifactsArtifactEvents(input: { "incident": string; "artifact": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/events", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/files/{file}
   */
  getPublicSafetyIncidentsIncidentManagedArtifactsArtifactFilesFile(input: { "incident": string; "artifact": string; "file": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/files/{file}", input ?? {}, [], false, options)
  },

  /**
   * HEAD /api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/files/{file}
   */
  headPublicSafetyIncidentsIncidentManagedArtifactsArtifactFilesFile(input: { "incident": string; "artifact": string; "file": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "HEAD", "/api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/files/{file}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/reconcile
   */
  postPublicSafetyIncidentsIncidentManagedArtifactsArtifactReconcile(input: { "incident": string; "artifact": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/managed-artifacts/{artifact}/reconcile", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/public-safety/incidents/{incident}/members
   */
  putPublicSafetyIncidentsIncidentMembers(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/public-safety/incidents/{incident}/members", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/observations
   */
  getPublicSafetyIncidentsIncidentObservations(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/observations", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/observations
   */
  postPublicSafetyIncidentsIncidentObservations(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/observations", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/observations/{observation}
   */
  getPublicSafetyIncidentsIncidentObservationsObservation(input: { "incident": string; "observation": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/observations/{observation}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/observations/{observation}/reviews
   */
  getPublicSafetyIncidentsIncidentObservationsObservationReviews(input: { "incident": string; "observation": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/observations/{observation}/reviews", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/observations/{observation}/reviews
   */
  postPublicSafetyIncidentsIncidentObservationsObservationReviews(input: { "incident": string; "observation": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/observations/{observation}/reviews", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention
   */
  getPublicSafetyIncidentsIncidentRetention(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/retention/enrollment
   */
  postPublicSafetyIncidentsIncidentRetentionEnrollment(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/retention/enrollment", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention/events
   */
  getPublicSafetyIncidentsIncidentRetentionEvents(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention/events", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/retention/hold
   */
  postPublicSafetyIncidentsIncidentRetentionHold(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/retention/hold", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention/preview
   */
  getPublicSafetyIncidentsIncidentRetentionPreview(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention/preview", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/retention/purge
   */
  postPublicSafetyIncidentsIncidentRetentionPurge(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/retention/purge", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention/purge/preview
   */
  getPublicSafetyIncidentsIncidentRetentionPurgePreview(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention/purge/preview", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention/purge/{purge}
   */
  getPublicSafetyIncidentsIncidentRetentionPurgePurge(input: { "incident": string; "purge": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention/purge/{purge}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/retention/purge/{purge}/events
   */
  getPublicSafetyIncidentsIncidentRetentionPurgePurgeEvents(input: { "incident": string; "purge": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/retention/purge/{purge}/events", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/retention/purge/{purge}/retry
   */
  postPublicSafetyIncidentsIncidentRetentionPurgePurgeRetry(input: { "incident": string; "purge": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/retention/purge/{purge}/retry", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/retention/revoke-member
   */
  postPublicSafetyIncidentsIncidentRetentionRevokeMember(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/retention/revoke-member", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/sources
   */
  getPublicSafetyIncidentsIncidentSources(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/sources", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/sources
   */
  postPublicSafetyIncidentsIncidentSources(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/sources", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/sources/{digest}
   */
  getPublicSafetyIncidentsIncidentSourcesDigest(input: { "incident": string; "digest": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/sources/{digest}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/workspace
   */
  getPublicSafetyIncidentsIncidentWorkspace(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/workspace", input ?? {}, [], false, options)
  },

  /**
   * HEAD /api/public-safety/incidents/{incident}/workspace
   */
  headPublicSafetyIncidentsIncidentWorkspace(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "HEAD", "/api/public-safety/incidents/{incident}/workspace", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/workspace/events
   */
  getPublicSafetyIncidentsIncidentWorkspaceEvents(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/workspace/events", input ?? {}, [], false, options)
  },

  /**
   * HEAD /api/public-safety/incidents/{incident}/workspace/events
   */
  headPublicSafetyIncidentsIncidentWorkspaceEvents(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "HEAD", "/api/public-safety/incidents/{incident}/workspace/events", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/workspace/execution
   */
  getPublicSafetyIncidentsIncidentWorkspaceExecution(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/workspace/execution", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/workspace/execution
   */
  postPublicSafetyIncidentsIncidentWorkspaceExecution(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/workspace/execution", input ?? {}, [], false, options)
  },

  /**
   * HEAD /api/public-safety/incidents/{incident}/workspace/execution
   */
  headPublicSafetyIncidentsIncidentWorkspaceExecution(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "HEAD", "/api/public-safety/incidents/{incident}/workspace/execution", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/workspace/execution/admission
   */
  postPublicSafetyIncidentsIncidentWorkspaceExecutionAdmission(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/workspace/execution/admission", input ?? {}, [], false, options)
  },

  /**
   * POST /api/public-safety/incidents/{incident}/workspace/execution/close
   */
  postPublicSafetyIncidentsIncidentWorkspaceExecutionClose(input: { "incident": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/public-safety/incidents/{incident}/workspace/execution/close", input ?? {}, [], false, options)
  },

  /**
   * GET /api/public-safety/incidents/{incident}/workspace/execution/{execution}/events
   */
  getPublicSafetyIncidentsIncidentWorkspaceExecutionExecutionEvents(input: { "incident": string; "execution": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/public-safety/incidents/{incident}/workspace/execution/{execution}/events", input ?? {}, [], false, options)
  },

  /**
   * HEAD /api/public-safety/incidents/{incident}/workspace/execution/{execution}/events
   */
  headPublicSafetyIncidentsIncidentWorkspaceExecutionExecutionEvents(input: { "incident": string; "execution": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "HEAD", "/api/public-safety/incidents/{incident}/workspace/execution/{execution}/events", input ?? {}, [], false, options)
  },
  }
}

export type Client = ReturnType<typeof createClient>
