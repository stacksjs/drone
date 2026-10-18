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
   * GET /_stacks/email/unsubscribe/{token}
   */
  getStacksEmailUnsubscribeToken(input: { "token": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/email/unsubscribe/{token}", input ?? {}, [], false, options)
  },

  /**
   * POST /_stacks/email/unsubscribe/{token}
   */
  postStacksEmailUnsubscribeToken(input: { "token": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/_stacks/email/unsubscribe/{token}", input ?? {}, [], false, options)
  },

  /**
   * GET /_stacks/mail/preview
   */
  getStacksMailPreview(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview", {}, [], false, options)
  },

  /**
   * GET /_stacks/mail/preview/{name}
   */
  getStacksMailPreviewName(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}", input ?? {}, [], false, options)
  },

  /**
   * GET /_stacks/mail/preview/{name}/raw
   */
  getStacksMailPreviewNameRaw(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}/raw", input ?? {}, [], false, options)
  },

  /**
   * GET /api/activities
   */
  getActivities(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "description": string; "subject_type"?: string; "subject_id"?: number; "causer"?: string; "properties"?: string; "ip_address"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/activities", {}, [], false, options)
  },

  /**
   * GET /api/activities/{id}
   */
  getActivitiesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "description": string; "subject_type"?: string; "subject_id"?: number; "causer"?: string; "properties"?: string; "ip_address"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/activities/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/analytics-events
   */
  getAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/analytics-events", {}, [], false, options)
  },

  /**
   * POST /api/analytics-events
   */
  postAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/analytics-events", {}, [], false, options)
  },

  /**
   * POST /api/analytics-events/bulk-delete
   */
  postAnalyticsEventsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/analytics-events/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/analytics-events/{id}
   */
  getAnalyticsEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/analytics-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/analytics-events/{id}
   */
  deleteAnalyticsEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/analytics-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/auction-items
   */
  getAuctionItems(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/auction-items", {}, [], false, options)
  },

  /**
   * POST /api/auction-items
   */
  postAuctionItems(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/auction-items", {}, [], false, options)
  },

  /**
   * POST /api/auction-items/bulk-delete
   */
  postAuctionItemsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auction-items/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/auction-items/{id}
   */
  getAuctionItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/auction-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/auction-items/{id}
   */
  putAuctionItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/auction-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/auction-items/{id}
   */
  deleteAuctionItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/auction-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/auction-items/{id}
   */
  patchAuctionItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "lot_number"?: number; "title"?: string; "description"?: string; "image_url"?: string; "category"?: string; "donor_name"?: string; "fair_market_value"?: number; "starting_bid"?: number; "min_increment"?: number; "buy_now_price"?: number; "reserve_price"?: number; "status"?: "open" | "closed" | "sold" | "passed"; "closes_at"?: unknown; "extension_count"?: number; "auction_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/auction-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/auctions
   */
  getAuctions(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/auctions", {}, [], false, options)
  },

  /**
   * POST /api/auctions
   */
  postAuctions(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/auctions", {}, [], false, options)
  },

  /**
   * POST /api/auctions/bulk-delete
   */
  postAuctionsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auctions/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/auctions/{id}
   */
  getAuctionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/auctions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/auctions/{id}
   */
  putAuctionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/auctions/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/auctions/{id}
   */
  deleteAuctionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/auctions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/auctions/{id}
   */
  patchAuctionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "event_id"?: number; "title"?: string; "description"?: string; "status"?: "draft" | "preview" | "open" | "closed" | "settled"; "currency"?: string; "goal_amount"?: number; "opens_at"?: unknown; "closes_at"?: unknown; "anti_snipe_minutes"?: number; "extend_on_bid_window_minutes"?: number; "max_extensions"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/auctions/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/authors
   */
  getAuthors(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/authors", {}, [], false, options)
  },

  /**
   * POST /api/authors
   */
  postAuthors(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/authors", {}, [], false, options)
  },

  /**
   * POST /api/authors/bulk-delete
   */
  postAuthorsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/authors/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/authors/{id}
   */
  getAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/authors/{id}
   */
  putAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/authors/{id}
   */
  deleteAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/authors/{id}
   */
  patchAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/automation-runs
   */
  getAutomationRuns(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"; "current_node_id"?: string; "version": number; "subject_type"?: string; "subject_id"?: string; "context": unknown; "idempotency_key": string; "started_at"?: unknown; "finished_at"?: unknown; "error"?: string; "team_id"?: number; "automation_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/automation-runs", {}, [], false, options)
  },

  /**
   * GET /api/automation-runs/{id}
   */
  getAutomationRunsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"; "current_node_id"?: string; "version": number; "subject_type"?: string; "subject_id"?: string; "context": unknown; "idempotency_key": string; "started_at"?: unknown; "finished_at"?: unknown; "error"?: string; "team_id"?: number; "automation_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/automation-runs/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/automations
   */
  getAutomations(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/automations", {}, [], false, options)
  },

  /**
   * POST /api/automations
   */
  postAutomations(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/automations", {}, [], false, options)
  },

  /**
   * POST /api/automations/bulk-delete
   */
  postAutomationsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/automations/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/automations/{id}
   */
  getAutomationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/automations/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/automations/{id}
   */
  putAutomationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/automations/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/automations/{id}
   */
  deleteAutomationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/automations/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/automations/{id}
   */
  patchAutomationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "status": "draft" | "active" | "paused" | "archived"; "version": number; "trigger": unknown; "graph": unknown; "published_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/automations/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/bids
   */
  getBids(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "bidder_name"?: string; "bidder_email"?: string; "amount"?: number; "status"?: "leading" | "outbid" | "won" | "lost" | "invalid"; "placed_at"?: unknown; "auction_id"?: number; "auction_item_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/bids", {}, [], false, options)
  },

  /**
   * GET /api/bids/{id}
   */
  getBidsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "bidder_name"?: string; "bidder_email"?: string; "amount"?: number; "status"?: "leading" | "outbid" | "won" | "lost" | "invalid"; "placed_at"?: unknown; "auction_id"?: number; "auction_item_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/bids/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/board-columns
   */
  getBoardColumns(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/board-columns", {}, [], false, options)
  },

  /**
   * POST /api/board-columns
   */
  postBoardColumns(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/board-columns", {}, [], false, options)
  },

  /**
   * POST /api/board-columns/bulk-delete
   */
  postBoardColumnsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/board-columns/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/board-columns/{id}
   */
  getBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/board-columns/{id}
   */
  putBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/board-columns/{id}
   */
  deleteBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/board-columns/{id}
   */
  patchBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/boards
   */
  getBoards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/boards", {}, [], false, options)
  },

  /**
   * POST /api/boards
   */
  postBoards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/boards", {}, [], false, options)
  },

  /**
   * POST /api/boards/bulk-delete
   */
  postBoardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/boards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/boards/{id}
   */
  getBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/boards/{id}
   */
  putBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/boards/{id}
   */
  deleteBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/boards/{id}
   */
  patchBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/boards/{id}", input ?? {}, [], false, options)
  },

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
   * GET /api/campaign-sends
   */
  getCampaignSends(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "campaign_id": number; "subscriber_id"?: number; "email_list_id"?: number; "status": "queued" | "deferred" | "sending" | "sent" | "delivered" | "failed" | "undelivered" | "bounced" | "complained" | "suppressed" | "cancelled"; "channel": "email" | "sms" | "push"; "recipient": string; "idempotency_key": string; "provider_message_id"?: string; "error"?: string; "sent_at"?: unknown; "opened_at"?: unknown; "clicked_at"?: unknown; "delivered_at"?: unknown; "failed_at"?: unknown; "segments"?: number; "cost"?: number; "metadata"?: unknown; "team_id"?: number; "campaign_variant_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/campaign-sends", {}, [], false, options)
  },

  /**
   * GET /api/campaign-sends/{id}
   */
  getCampaignSendsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "campaign_id": number; "subscriber_id"?: number; "email_list_id"?: number; "status": "queued" | "deferred" | "sending" | "sent" | "delivered" | "failed" | "undelivered" | "bounced" | "complained" | "suppressed" | "cancelled"; "channel": "email" | "sms" | "push"; "recipient": string; "idempotency_key": string; "provider_message_id"?: string; "error"?: string; "sent_at"?: unknown; "opened_at"?: unknown; "clicked_at"?: unknown; "delivered_at"?: unknown; "failed_at"?: unknown; "segments"?: number; "cost"?: number; "metadata"?: unknown; "team_id"?: number; "campaign_variant_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/campaign-sends/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/campaign-variants
   */
  getCampaignVariants(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/campaign-variants", {}, [], false, options)
  },

  /**
   * POST /api/campaign-variants
   */
  postCampaignVariants(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/campaign-variants", {}, [], false, options)
  },

  /**
   * POST /api/campaign-variants/bulk-delete
   */
  postCampaignVariantsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/campaign-variants/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/campaign-variants/{id}
   */
  getCampaignVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/campaign-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/campaign-variants/{id}
   */
  putCampaignVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/campaign-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/campaign-variants/{id}
   */
  deleteCampaignVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/campaign-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/campaign-variants/{id}
   */
  patchCampaignVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subject"?: string; "content": unknown; "allocation": number; "sent_count": number; "open_count": number; "click_count": number; "conversion_count": number; "is_winner": boolean; "team_id"?: number; "campaign_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/campaign-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/campaigns
   */
  getCampaigns(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/campaigns", {}, [], false, options)
  },

  /**
   * POST /api/campaigns
   */
  postCampaigns(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/campaigns", {}, [], false, options)
  },

  /**
   * POST /api/campaigns/bulk-delete
   */
  postCampaignsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/campaigns/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/campaigns/{id}
   */
  getCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/campaigns/{id}
   */
  putCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/campaigns/{id}
   */
  deleteCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/campaigns/{id}
   */
  patchCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "content"?: unknown; "channel_settings"?: unknown; "segment_definition"?: unknown; "from_name"?: string; "from_address"?: string; "reply_to"?: string; "timezone": string; "recurrence"?: string; "experiment_metric"?: "open_rate" | "click_rate" | "conversion_rate"; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/card-comments
   */
  getCardComments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/card-comments", {}, [], false, options)
  },

  /**
   * POST /api/card-comments
   */
  postCardComments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/card-comments", {}, [], false, options)
  },

  /**
   * POST /api/card-comments/bulk-delete
   */
  postCardCommentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/card-comments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/card-comments/{id}
   */
  getCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/card-comments/{id}
   */
  putCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/card-comments/{id}
   */
  deleteCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/card-comments/{id}
   */
  patchCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/cards
   */
  getCards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/cards", {}, [], false, options)
  },

  /**
   * POST /api/cards
   */
  postCards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/cards", {}, [], false, options)
  },

  /**
   * POST /api/cards/bulk-delete
   */
  postCardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/cards/{id}
   */
  getCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/cards/{id}
   */
  putCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/cards/{id}
   */
  deleteCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/cards/{id}
   */
  patchCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/cart-items
   */
  getCartItems(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/cart-items", {}, [], false, options)
  },

  /**
   * POST /api/cart-items
   */
  postCartItems(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/cart-items", {}, [], false, options)
  },

  /**
   * POST /api/cart-items/bulk-delete
   */
  postCartItemsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cart-items/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/cart-items/{id}
   */
  getCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/cart-items/{id}
   */
  putCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/cart-items/{id}
   */
  deleteCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/cart-items/{id}
   */
  patchCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/carts
   */
  getCarts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/carts", {}, [], false, options)
  },

  /**
   * POST /api/carts
   */
  postCarts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/carts", {}, [], false, options)
  },

  /**
   * POST /api/carts/bulk-delete
   */
  postCartsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/carts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/carts/{id}
   */
  getCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/carts/{id}
   */
  putCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/carts/{id}
   */
  deleteCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/carts/{id}
   */
  patchCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/comments
   */
  getComments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/comments", {}, [], false, options)
  },

  /**
   * POST /api/comments
   */
  postComments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/comments", {}, [], false, options)
  },

  /**
   * POST /api/comments/bulk-delete
   */
  postCommentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/comments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/comments/{id}
   */
  getCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/comments/{id}
   */
  putCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/comments/{id}
   */
  deleteCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/comments/{id}
   */
  patchCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/communication-suppressions
   */
  getCommunicationSuppressions(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "reason": "unsubscribe" | "bounce" | "complaint" | "carrier" | "manual" | "legal"; "source": string; "suppressed_at": unknown; "lifted_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/communication-suppressions", {}, [], false, options)
  },

  /**
   * POST /api/communication-suppressions
   */
  postCommunicationSuppressions(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "reason": "unsubscribe" | "bounce" | "complaint" | "carrier" | "manual" | "legal"; "source": string; "suppressed_at": unknown; "lifted_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/communication-suppressions", {}, [], false, options)
  },

  /**
   * POST /api/communication-suppressions/bulk-delete
   */
  postCommunicationSuppressionsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/communication-suppressions/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/communication-suppressions/{id}
   */
  getCommunicationSuppressionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "reason": "unsubscribe" | "bounce" | "complaint" | "carrier" | "manual" | "legal"; "source": string; "suppressed_at": unknown; "lifted_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/communication-suppressions/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/communication-suppressions/{id}
   */
  deleteCommunicationSuppressionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "reason": "unsubscribe" | "bounce" | "complaint" | "carrier" | "manual" | "legal"; "source": string; "suppressed_at": unknown; "lifted_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/communication-suppressions/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/consent-events
   */
  getConsentEvents(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "action": "requested" | "granted" | "revoked" | "confirmed" | "suppressed"; "purpose": string; "source": string; "jurisdiction"?: string; "policy_version": string; "idempotency_key"?: string; "proof"?: unknown; "ip_address"?: string; "occurred_at": unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/consent-events", {}, [], false, options)
  },

  /**
   * GET /api/consent-events/{id}
   */
  getConsentEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "recipient": string; "channel": "email" | "sms" | "push"; "action": "requested" | "granted" | "revoked" | "confirmed" | "suppressed"; "purpose": string; "source": string; "jurisdiction"?: string; "policy_version": string; "idempotency_key"?: string; "proof"?: unknown; "ip_address"?: string; "occurred_at": unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/consent-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/coupons
   */
  getCoupons(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/coupons", {}, [], false, options)
  },

  /**
   * POST /api/coupons
   */
  postCoupons(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/coupons", {}, [], false, options)
  },

  /**
   * POST /api/coupons/bulk-delete
   */
  postCouponsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/coupons/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/coupons/{id}
   */
  getCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/coupons/{id}
   */
  putCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/coupons/{id}
   */
  deleteCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/coupons/{id}
   */
  patchCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/couriers
   */
  getCouriers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/couriers", {}, [], false, options)
  },

  /**
   * POST /api/couriers
   */
  postCouriers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/couriers", {}, [], false, options)
  },

  /**
   * POST /api/couriers/bulk-delete
   */
  postCouriersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/couriers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/couriers/{id}
   */
  getCouriersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/couriers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/couriers/{id}
   */
  putCouriersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/couriers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/couriers/{id}
   */
  deleteCouriersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/couriers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/couriers/{id}
   */
  patchCouriersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break" | "offline"; "latitude"?: number; "longitude"?: number; "heading"?: number; "speed"?: number; "last_ping_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/couriers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/customers
   */
  getCustomers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/customers", {}, [], false, options)
  },

  /**
   * POST /api/customers
   */
  postCustomers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/customers", {}, [], false, options)
  },

  /**
   * POST /api/customers/bulk-delete
   */
  postCustomersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/customers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/customers/{id}
   */
  getCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/customers/{id}
   */
  putCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/customers/{id}
   */
  deleteCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/customers/{id}
   */
  patchCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/delivery-routes
   */
  getDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/delivery-routes
   */
  postDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/delivery-routes/bulk-delete
   */
  postDeliveryRoutesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/delivery-routes/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/delivery-routes/{id}
   */
  getDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/delivery-routes/{id}
   */
  putDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/delivery-routes/{id}
   */
  deleteDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/delivery-routes/{id}
   */
  patchDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "courier"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "status"?: "planned" | "active" | "completed" | "cancelled"; "started_at"?: unknown; "completed_at"?: unknown; "courier_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/delivery-stops
   */
  getDeliveryStops(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/delivery-stops", {}, [], false, options)
  },

  /**
   * POST /api/delivery-stops
   */
  postDeliveryStops(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/delivery-stops", {}, [], false, options)
  },

  /**
   * POST /api/delivery-stops/bulk-delete
   */
  postDeliveryStopsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/delivery-stops/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/delivery-stops/{id}
   */
  getDeliveryStopsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/delivery-stops/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/delivery-stops/{id}
   */
  putDeliveryStopsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/delivery-stops/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/delivery-stops/{id}
   */
  deleteDeliveryStopsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/delivery-stops/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/delivery-stops/{id}
   */
  patchDeliveryStopsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "sequence": number; "status": "pending" | "en_route" | "arrived" | "completed" | "failed" | "skipped"; "address": string; "latitude"?: number; "longitude"?: number; "recipient_name"?: string; "recipient_phone"?: string; "eta_at"?: unknown; "notified_nearby_at"?: unknown; "arrived_at"?: unknown; "completed_at"?: unknown; "notes"?: string; "type": "pickup" | "dropoff"; "delivery_route_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/delivery-stops/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/deployments
   */
  getDeployments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "commit_hash"?: string; "commit_message"?: string; "branch"?: string; "status"?: string; "environment"?: string; "duration"?: number; "author"?: string; "url"?: string; "error_log"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/deployments", {}, [], false, options)
  },

  /**
   * GET /api/deployments/{id}
   */
  getDeploymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "commit_hash"?: string; "commit_message"?: string; "branch"?: string; "status"?: string; "environment"?: string; "duration"?: number; "author"?: string; "url"?: string; "error_log"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/deployments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/digital-deliveries
   */
  getDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/digital-deliveries
   */
  postDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/digital-deliveries/bulk-delete
   */
  postDigitalDeliveriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/digital-deliveries/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/digital-deliveries/{id}
   */
  getDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/digital-deliveries/{id}
   */
  putDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/digital-deliveries/{id}
   */
  deleteDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/digital-deliveries/{id}
   */
  patchDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/drone/capabilities
   */
  getDroneCapabilities(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/drone/capabilities", {}, [], false, options)
  },

  /**
   * GET /api/email-idempotency
   */
  getEmailIdempotency(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "message_id"?: string; "provider"?: string; "success": boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-idempotency", {}, [], false, options)
  },

  /**
   * POST /api/email-idempotency/bulk-delete
   */
  postEmailIdempotencyBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email-idempotency/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/email-idempotency/{id}
   */
  getEmailIdempotencyId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "message_id"?: string; "provider"?: string; "success": boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-idempotency/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/email-idempotency/{id}
   */
  deleteEmailIdempotencyId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "message_id"?: string; "provider"?: string; "success": boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/email-idempotency/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-list-subscribers
   */
  getEmailListSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email_list_id": number; "subscriber_id": number; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "subscribed_at"?: unknown; "unsubscribed_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-list-subscribers", {}, [], false, options)
  },

  /**
   * GET /api/email-list-subscribers/{id}
   */
  getEmailListSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email_list_id": number; "subscriber_id": number; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "subscribed_at"?: unknown; "unsubscribed_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-list-subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-lists
   */
  getEmailLists(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-lists", {}, [], false, options)
  },

  /**
   * POST /api/email-lists
   */
  postEmailLists(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/email-lists", {}, [], false, options)
  },

  /**
   * POST /api/email-lists/bulk-delete
   */
  postEmailListsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email-lists/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/email-lists/{id}
   */
  getEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/email-lists/{id}
   */
  putEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/email-lists/{id}
   */
  deleteEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/email-lists/{id}
   */
  patchEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-suppressions
   */
  getEmailSuppressions(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "email": string; "type": "bounce" | "complaint" | "unsubscribe" | "manual"; "reason"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-suppressions", {}, [], false, options)
  },

  /**
   * POST /api/email-suppressions/bulk-delete
   */
  postEmailSuppressionsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email-suppressions/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/email-suppressions/{id}
   */
  getEmailSuppressionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "email": string; "type": "bounce" | "complaint" | "unsubscribe" | "manual"; "reason"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-suppressions/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/email-suppressions/{id}
   */
  deleteEmailSuppressionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "email": string; "type": "bounce" | "complaint" | "unsubscribe" | "manual"; "reason"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/email-suppressions/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-webhook-events
   */
  getEmailWebhookEvents(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "provider": "mailgun" | "postmark" | "ses" | "sendgrid"; "processed_at": unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-webhook-events", {}, [], false, options)
  },

  /**
   * POST /api/email-webhook-events/bulk-delete
   */
  postEmailWebhookEventsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email-webhook-events/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/email-webhook-events/{id}
   */
  getEmailWebhookEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "provider": "mailgun" | "postmark" | "ses" | "sendgrid"; "processed_at": unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-webhook-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/email-webhook-events/{id}
   */
  deleteEmailWebhookEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "provider": "mailgun" | "postmark" | "ses" | "sendgrid"; "processed_at": unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/email-webhook-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/form-fields
   */
  getFormFields(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/form-fields", {}, [], false, options)
  },

  /**
   * POST /api/form-fields
   */
  postFormFields(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/form-fields", {}, [], false, options)
  },

  /**
   * POST /api/form-fields/bulk-delete
   */
  postFormFieldsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/form-fields/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/form-fields/{id}
   */
  getFormFieldsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/form-fields/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/form-fields/{id}
   */
  putFormFieldsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/form-fields/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/form-fields/{id}
   */
  deleteFormFieldsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/form-fields/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/form-fields/{id}
   */
  patchFormFieldsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "name": string; "label": string; "type": "text" | "textarea" | "email" | "phone" | "select" | "checkbox" | "radio" | "date" | "file" | "currency" | "section_break"; "required"?: boolean; "position"?: number; "width"?: "full" | "half"; "options"?: unknown; "conditions"?: unknown; "form_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/form-fields/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/forms
   */
  getForms(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/forms", {}, [], false, options)
  },

  /**
   * POST /api/forms
   */
  postForms(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/forms", {}, [], false, options)
  },

  /**
   * POST /api/forms/bulk-delete
   */
  postFormsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/forms/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/forms/{id}
   */
  getFormsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/forms/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/forms/{id}
   */
  putFormsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/forms/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/forms/{id}
   */
  deleteFormsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/forms/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/forms/{id}
   */
  patchFormsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "handle": string; "status"?: "draft" | "active" | "closed"; "settings"?: unknown; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/forms/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/gift-cards
   */
  getGiftCards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/gift-cards", {}, [], false, options)
  },

  /**
   * POST /api/gift-cards
   */
  postGiftCards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/gift-cards", {}, [], false, options)
  },

  /**
   * POST /api/gift-cards/bulk-delete
   */
  postGiftCardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/gift-cards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/gift-cards/{id}
   */
  getGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/gift-cards/{id}
   */
  putGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/gift-cards/{id}
   */
  deleteGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/gift-cards/{id}
   */
  patchGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: "ACTIVE" | "USED" | "EXPIRED" | "DEACTIVATED"; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/labels
   */
  getLabels(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/labels", {}, [], false, options)
  },

  /**
   * POST /api/labels
   */
  postLabels(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/labels", {}, [], false, options)
  },

  /**
   * POST /api/labels/bulk-delete
   */
  postLabelsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/labels/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/labels/{id}
   */
  getLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/labels/{id}
   */
  putLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/labels/{id}
   */
  deleteLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/labels/{id}
   */
  patchLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/license-keys
   */
  getLicenseKeys(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/license-keys
   */
  postLicenseKeys(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/license-keys/bulk-delete
   */
  postLicenseKeysBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/license-keys/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/license-keys/{id}
   */
  getLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/license-keys/{id}
   */
  putLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/license-keys/{id}
   */
  deleteLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/license-keys/{id}
   */
  patchLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/logs
   */
  getLogs(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "timestamp"?: number; "type"?: "warning" | "error" | "info" | "success"; "source"?: "file" | "cli" | "system"; "message"?: string; "project"?: string; "stacktrace"?: string; "file"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/logs", {}, [], false, options)
  },

  /**
   * GET /api/logs/{id}
   */
  getLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "timestamp"?: number; "type"?: "warning" | "error" | "info" | "success"; "source"?: "file" | "cli" | "system"; "message"?: string; "project"?: string; "stacktrace"?: string; "file"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/loyalty-points
   */
  getLoyaltyPoints(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/loyalty-points", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-points
   */
  postLoyaltyPoints(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/loyalty-points", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-points/bulk-delete
   */
  postLoyaltyPointsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/loyalty-points/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/loyalty-points/{id}
   */
  getLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/loyalty-points/{id}
   */
  putLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/loyalty-points/{id}
   */
  deleteLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/loyalty-points/{id}
   */
  patchLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/loyalty-rewards
   */
  getLoyaltyRewards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/loyalty-rewards", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-rewards
   */
  postLoyaltyRewards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/loyalty-rewards", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-rewards/bulk-delete
   */
  postLoyaltyRewardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/loyalty-rewards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/loyalty-rewards/{id}
   */
  getLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/loyalty-rewards/{id}
   */
  putLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/loyalty-rewards/{id}
   */
  deleteLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/loyalty-rewards/{id}
   */
  patchLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/mail-preferences
   */
  getMailPreferences(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/mail-preferences", {}, [], false, options)
  },

  /**
   * POST /api/mail-preferences
   */
  postMailPreferences(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/mail-preferences", {}, [], false, options)
  },

  /**
   * POST /api/mail-preferences/bulk-delete
   */
  postMailPreferencesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mail-preferences/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/mail-preferences/{id}
   */
  getMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/mail-preferences/{id}
   */
  putMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/mail-preferences/{id}
   */
  deleteMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/mail-preferences/{id}
   */
  patchMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/menu-items
   */
  getMenuItems(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/menu-items", {}, [], false, options)
  },

  /**
   * POST /api/menu-items
   */
  postMenuItems(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/menu-items", {}, [], false, options)
  },

  /**
   * POST /api/menu-items/bulk-delete
   */
  postMenuItemsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/menu-items/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/menu-items/{id}
   */
  getMenuItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/menu-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/menu-items/{id}
   */
  putMenuItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/menu-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/menu-items/{id}
   */
  deleteMenuItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/menu-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/menu-items/{id}
   */
  patchMenuItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "label": string; "url"?: string; "target"?: "_self" | "_blank"; "parent_id"?: number; "position"?: number; "visibility"?: "public" | "auth"; "menu_id"?: number; "page_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/menu-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/menus
   */
  getMenus(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/menus", {}, [], false, options)
  },

  /**
   * POST /api/menus
   */
  postMenus(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/menus", {}, [], false, options)
  },

  /**
   * POST /api/menus/bulk-delete
   */
  postMenusBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/menus/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/menus/{id}
   */
  getMenusId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/menus/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/menus/{id}
   */
  putMenusId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/menus/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/menus/{id}
   */
  deleteMenusId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/menus/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/menus/{id}
   */
  patchMenusId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "handle": string; "name": string; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/menus/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries
   */
  getNotificationDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "user_id"?: number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notification-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/notification-deliveries/bulk-delete
   */
  postNotificationDeliveriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/notification-deliveries/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries/{id}
   */
  getNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "user_id"?: number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notification-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/notification-deliveries/{id}
   */
  deleteNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "user_id"?: number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/notification-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/notifications
   */
  getNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notifications", {}, [], false, options)
  },

  /**
   * POST /api/notifications
   */
  postNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/notifications", {}, [], false, options)
  },

  /**
   * POST /api/notifications/bulk-delete
   */
  postNotificationsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/notifications/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/notifications/{id}
   */
  getNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/notifications/{id}
   */
  putNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/notifications/{id}
   */
  deleteNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/notifications/{id}
   */
  patchNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/orders
   */
  getOrders(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/orders", {}, [], false, options)
  },

  /**
   * POST /api/orders
   */
  postOrders(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/orders", {}, [], false, options)
  },

  /**
   * POST /api/orders/bulk-delete
   */
  postOrdersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orders/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/orders/{id}
   */
  getOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/orders/{id}
   */
  putOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/orders/{id}
   */
  deleteOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/orders/{id}
   */
  patchOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "tracking_token"?: string; "delivery_latitude"?: number; "delivery_longitude"?: number; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/pages
   */
  getPages(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/pages", {}, [], false, options)
  },

  /**
   * POST /api/pages
   */
  postPages(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/pages", {}, [], false, options)
  },

  /**
   * POST /api/pages/bulk-delete
   */
  postPagesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/pages/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/pages/{id}
   */
  getPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/pages/{id}
   */
  putPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/pages/{id}
   */
  deletePagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/pages/{id}
   */
  patchPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "path"?: string; "parent_id"?: number; "template": string; "blocks"?: unknown; "meta_description"?: string; "status"?: "draft" | "published" | "scheduled" | "archived"; "scheduled_at"?: unknown; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/payments
   */
  getPayments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/payments", {}, [], false, options)
  },

  /**
   * POST /api/payments
   */
  postPayments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/payments", {}, [], false, options)
  },

  /**
   * POST /api/payments/bulk-delete
   */
  postPaymentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/payments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/payments/{id}
   */
  getPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/payments/{id}
   */
  putPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/payments/{id}
   */
  deletePaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/payments/{id}
   */
  patchPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "failure_reason"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/pledges
   */
  getPledges(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/pledges", {}, [], false, options)
  },

  /**
   * POST /api/pledges
   */
  postPledges(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/pledges", {}, [], false, options)
  },

  /**
   * POST /api/pledges/bulk-delete
   */
  postPledgesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/pledges/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/pledges/{id}
   */
  getPledgesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/pledges/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/pledges/{id}
   */
  putPledgesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/pledges/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/pledges/{id}
   */
  deletePledgesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/pledges/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/pledges/{id}
   */
  patchPledgesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "donor_name"?: string; "donor_email"?: string; "amount"?: number; "level"?: string; "status"?: "pending" | "confirmed" | "cancelled"; "auction_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/pledges/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/posts
   */
  getPosts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/posts", {}, [], false, options)
  },

  /**
   * POST /api/posts
   */
  postPosts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/posts", {}, [], false, options)
  },

  /**
   * POST /api/posts/bulk-delete
   */
  postPostsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/posts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/posts/{id}
   */
  getPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/posts/{id}
   */
  putPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/posts/{id}
   */
  deletePostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/posts/{id}
   */
  patchPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "slug"?: string; "poster"?: string; "content": string; "excerpt"?: string; "focus_keyword"?: string; "meta_description"?: string; "canonical_url"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/print-devices
   */
  getPrintDevices(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/print-devices", {}, [], false, options)
  },

  /**
   * POST /api/print-devices
   */
  postPrintDevices(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/print-devices", {}, [], false, options)
  },

  /**
   * POST /api/print-devices/bulk-delete
   */
  postPrintDevicesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/print-devices/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/print-devices/{id}
   */
  getPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/print-devices/{id}
   */
  putPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/print-devices/{id}
   */
  deletePrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/print-devices/{id}
   */
  patchPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/print-logs
   */
  getPrintLogs(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/print-logs", {}, [], false, options)
  },

  /**
   * POST /api/print-logs
   */
  postPrintLogs(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/print-logs", {}, [], false, options)
  },

  /**
   * POST /api/print-logs/bulk-delete
   */
  postPrintLogsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/print-logs/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/print-logs/{id}
   */
  getPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/print-logs/{id}
   */
  putPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/print-logs/{id}
   */
  deletePrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/print-logs/{id}
   */
  patchPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-categories
   */
  getProductCategories(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-categories", {}, [], false, options)
  },

  /**
   * POST /api/product-categories
   */
  postProductCategories(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-categories", {}, [], false, options)
  },

  /**
   * POST /api/product-categories/bulk-delete
   */
  postProductCategoriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-categories/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-categories/{id}
   */
  getProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-categories/{id}
   */
  putProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-categories/{id}
   */
  deleteProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-categories/{id}
   */
  patchProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-manufacturers
   */
  getProductManufacturers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-manufacturers", {}, [], false, options)
  },

  /**
   * POST /api/product-manufacturers
   */
  postProductManufacturers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-manufacturers", {}, [], false, options)
  },

  /**
   * POST /api/product-manufacturers/bulk-delete
   */
  postProductManufacturersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-manufacturers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-manufacturers/{id}
   */
  getProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-manufacturers/{id}
   */
  putProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-manufacturers/{id}
   */
  deleteProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-manufacturers/{id}
   */
  patchProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-reviews
   */
  getProductReviews(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-reviews", {}, [], false, options)
  },

  /**
   * POST /api/product-reviews
   */
  postProductReviews(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-reviews", {}, [], false, options)
  },

  /**
   * POST /api/product-reviews/bulk-delete
   */
  postProductReviewsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-reviews/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-reviews/{id}
   */
  getProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-reviews/{id}
   */
  putProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-reviews/{id}
   */
  deleteProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-reviews/{id}
   */
  patchProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-units
   */
  getProductUnits(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-units", {}, [], false, options)
  },

  /**
   * POST /api/product-units
   */
  postProductUnits(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-units", {}, [], false, options)
  },

  /**
   * POST /api/product-units/bulk-delete
   */
  postProductUnitsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-units/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-units/{id}
   */
  getProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-units/{id}
   */
  putProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-units/{id}
   */
  deleteProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-units/{id}
   */
  patchProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-variants
   */
  getProductVariants(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-variants", {}, [], false, options)
  },

  /**
   * POST /api/product-variants
   */
  postProductVariants(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-variants", {}, [], false, options)
  },

  /**
   * POST /api/product-variants/bulk-delete
   */
  postProductVariantsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-variants/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-variants/{id}
   */
  getProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-variants/{id}
   */
  putProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-variants/{id}
   */
  deleteProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-variants/{id}
   */
  patchProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "sku"?: string; "price"?: number; "compare_at_price"?: number; "inventory_count"?: number; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/products
   */
  getProducts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/products", {}, [], false, options)
  },

  /**
   * POST /api/products
   */
  postProducts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/products", {}, [], false, options)
  },

  /**
   * POST /api/products/bulk-delete
   */
  postProductsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/products/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/products/{id}
   */
  getProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/products/{id}
   */
  putProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/products/{id}
   */
  deleteProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/products/{id}
   */
  patchProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/query-logs
   */
  getQueryLogs(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "query": string; "normalized_query"?: string; "duration"?: number; "connection"?: string; "status"?: "completed" | "failed" | "slow"; "error"?: string; "executed_at": string; "model"?: string; "method"?: string; "line"?: number; "memory_usage"?: number; "rows_affected"?: number; "transaction_id"?: string; "tags"?: string; "affected_tables"?: string; "indexes_used"?: string; "missing_indexes"?: string; "explain_plan"?: string; "optimization_suggestions"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/query-logs", {}, [], false, options)
  },

  /**
   * GET /api/query-logs/{id}
   */
  getQueryLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "query": string; "normalized_query"?: string; "duration"?: number; "connection"?: string; "status"?: "completed" | "failed" | "slow"; "error"?: string; "executed_at": string; "model"?: string; "method"?: string; "line"?: number; "memory_usage"?: number; "rows_affected"?: number; "transaction_id"?: string; "tags"?: string; "affected_tables"?: string; "indexes_used"?: string; "missing_indexes"?: string; "explain_plan"?: string; "optimization_suggestions"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/query-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/redirects
   */
  getRedirects(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/redirects", {}, [], false, options)
  },

  /**
   * POST /api/redirects
   */
  postRedirects(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/redirects", {}, [], false, options)
  },

  /**
   * POST /api/redirects/bulk-delete
   */
  postRedirectsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/redirects/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/redirects/{id}
   */
  getRedirectsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/redirects/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/redirects/{id}
   */
  putRedirectsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/redirects/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/redirects/{id}
   */
  deleteRedirectsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/redirects/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/redirects/{id}
   */
  patchRedirectsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "from_path": string; "to_path": string; "status_code"?: number; "source"?: "slug-change" | "manual"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/redirects/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/releases
   */
  getReleases(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/releases", {}, [], false, options)
  },

  /**
   * GET /api/releases/{id}
   */
  getReleasesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/releases/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/requests
   */
  getRequests(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string }> }>> {
    return request(config, "GET", "/api/requests", {}, [], false, options)
  },

  /**
   * POST /api/requests
   */
  postRequests(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "POST", "/api/requests", {}, [], false, options)
  },

  /**
   * POST /api/requests/bulk-delete
   */
  postRequestsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/requests/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/requests/{id}
   */
  getRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "GET", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/requests/{id}
   */
  putRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "PUT", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/requests/{id}
   */
  deleteRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "DELETE", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/requests/{id}
   */
  patchRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "PATCH", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/sender-domains
   */
  getSenderDomains(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/sender-domains", {}, [], false, options)
  },

  /**
   * POST /api/sender-domains
   */
  postSenderDomains(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/sender-domains", {}, [], false, options)
  },

  /**
   * POST /api/sender-domains/bulk-delete
   */
  postSenderDomainsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/sender-domains/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/sender-domains/{id}
   */
  getSenderDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/sender-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/sender-domains/{id}
   */
  putSenderDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/sender-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/sender-domains/{id}
   */
  deleteSenderDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/sender-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/sender-domains/{id}
   */
  patchSenderDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "domain": string; "status": "pending" | "verified" | "failed" | "disabled"; "selector": string; "dns_records"?: unknown; "verified_at"?: unknown; "last_checked_at"?: unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/sender-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/shipping-methods
   */
  getShippingMethods(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/shipping-methods
   */
  postShippingMethods(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/shipping-methods/bulk-delete
   */
  postShippingMethodsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-methods/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-methods/{id}
   */
  getShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-methods/{id}
   */
  putShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-methods/{id}
   */
  deleteShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-methods/{id}
   */
  patchShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/shipping-rates
   */
  getShippingRates(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/shipping-rates
   */
  postShippingRates(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/shipping-rates/bulk-delete
   */
  postShippingRatesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-rates/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-rates/{id}
   */
  getShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-rates/{id}
   */
  putShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-rates/{id}
   */
  deleteShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-rates/{id}
   */
  patchShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/shipping-zones
   */
  getShippingZones(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/shipping-zones
   */
  postShippingZones(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/shipping-zones/bulk-delete
   */
  postShippingZonesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-zones/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-zones/{id}
   */
  getShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-zones/{id}
   */
  putShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-zones/{id}
   */
  deleteShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-zones/{id}
   */
  patchShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/site-domains
   */
  getSiteDomains(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/site-domains", {}, [], false, options)
  },

  /**
   * POST /api/site-domains
   */
  postSiteDomains(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/site-domains", {}, [], false, options)
  },

  /**
   * POST /api/site-domains/bulk-delete
   */
  postSiteDomainsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/site-domains/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/site-domains/{id}
   */
  getSiteDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/site-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/site-domains/{id}
   */
  putSiteDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/site-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/site-domains/{id}
   */
  deleteSiteDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/site-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/site-domains/{id}
   */
  patchSiteDomainsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "domain": string; "is_primary"?: boolean; "verified_at"?: unknown; "ssl_status"?: "pending" | "issued" | "failed"; "site_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/site-domains/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/sites
   */
  getSites(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/sites", {}, [], false, options)
  },

  /**
   * POST /api/sites
   */
  postSites(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/sites", {}, [], false, options)
  },

  /**
   * POST /api/sites/bulk-delete
   */
  postSitesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/sites/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/sites/{id}
   */
  getSitesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/sites/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/sites/{id}
   */
  putSitesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/sites/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/sites/{id}
   */
  deleteSitesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/sites/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/sites/{id}
   */
  patchSitesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "subdomain": string; "status": "active" | "suspended" | "archived"; "settings"?: unknown; "timezone"?: string; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/sites/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/social-posts
   */
  getSocialPosts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/social-posts", {}, [], false, options)
  },

  /**
   * POST /api/social-posts
   */
  postSocialPosts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/social-posts", {}, [], false, options)
  },

  /**
   * POST /api/social-posts/bulk-delete
   */
  postSocialPostsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/social-posts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/social-posts/{id}
   */
  getSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/social-posts/{id}
   */
  putSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/social-posts/{id}
   */
  deleteSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/social-posts/{id}
   */
  patchSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/subscriber-emails
   */
  getSubscriberEmails(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email": string; "source"?: string; "subscriber_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/subscriber-emails", {}, [], false, options)
  },

  /**
   * GET /api/subscriber-emails/{id}
   */
  getSubscriberEmailsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "source"?: string; "subscriber_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/subscriber-emails/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/subscribers
   */
  getSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/subscribers", {}, [], false, options)
  },

  /**
   * POST /api/subscribers
   */
  postSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/subscribers", {}, [], false, options)
  },

  /**
   * POST /api/subscribers/bulk-delete
   */
  postSubscribersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/subscribers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/subscribers/{id}
   */
  getSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/subscribers/{id}
   */
  putSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/subscribers/{id}
   */
  deleteSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/subscribers/{id}
   */
  patchSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/tags
   */
  getTags(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/tags", {}, [], false, options)
  },

  /**
   * POST /api/tags
   */
  postTags(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/tags", {}, [], false, options)
  },

  /**
   * POST /api/tags/bulk-delete
   */
  postTagsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/tags/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/tags/{id}
   */
  getTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/tags/{id}
   */
  putTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/tags/{id}
   */
  deleteTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/tags/{id}
   */
  patchTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/tax-rates
   */
  getTaxRates(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/tax-rates", {}, [], false, options)
  },

  /**
   * POST /api/tax-rates
   */
  postTaxRates(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/tax-rates", {}, [], false, options)
  },

  /**
   * POST /api/tax-rates/bulk-delete
   */
  postTaxRatesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/tax-rates/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/tax-rates/{id}
   */
  getTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/tax-rates/{id}
   */
  putTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/tax-rates/{id}
   */
  deleteTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/tax-rates/{id}
   */
  patchTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "code"?: string; "exemptible"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/team-invitations
   */
  getTeamInvitations(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "team_id": number; "email": string; "role": "admin" | "member" | "viewer"; "invited_by_user_id"?: number; "accepted_by_user_id"?: number; "status": "pending" | "accepted" | "revoked" | "expired"; "delivery_status": "pending" | "sent" | "failed"; "expires_at": unknown; "delivered_at"?: unknown; "accepted_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/team-invitations", {}, [], false, options)
  },

  /**
   * POST /api/team-invitations/bulk-delete
   */
  postTeamInvitationsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/team-invitations/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/team-invitations/{id}
   */
  getTeamInvitationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "email": string; "role": "admin" | "member" | "viewer"; "invited_by_user_id"?: number; "accepted_by_user_id"?: number; "status": "pending" | "accepted" | "revoked" | "expired"; "delivery_status": "pending" | "sent" | "failed"; "expires_at": unknown; "delivered_at"?: unknown; "accepted_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/team-invitations/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/team-invitations/{id}
   */
  deleteTeamInvitationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "email": string; "role": "admin" | "member" | "viewer"; "invited_by_user_id"?: number; "accepted_by_user_id"?: number; "status": "pending" | "accepted" | "revoked" | "expired"; "delivery_status": "pending" | "sent" | "failed"; "expires_at": unknown; "delivered_at"?: unknown; "accepted_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/team-invitations/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/team-members
   */
  getTeamMembers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/team-members", {}, [], false, options)
  },

  /**
   * POST /api/team-members
   */
  postTeamMembers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/team-members", {}, [], false, options)
  },

  /**
   * POST /api/team-members/bulk-delete
   */
  postTeamMembersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/team-members/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/team-members/{id}
   */
  getTeamMembersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/team-members/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/team-members/{id}
   */
  putTeamMembersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/team-members/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/team-members/{id}
   */
  deleteTeamMembersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/team-members/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/team-members/{id}
   */
  patchTeamMembersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "team_id": number; "user_id": number; "role": "owner" | "admin" | "member" | "viewer"; "status": "active" | "suspended"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/team-members/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/teams
   */
  getTeams(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/teams", {}, [], false, options)
  },

  /**
   * POST /api/teams
   */
  postTeams(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/teams", {}, [], false, options)
  },

  /**
   * POST /api/teams/bulk-delete
   */
  postTeamsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/teams/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/teams/{id}
   */
  getTeamsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/teams/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/teams/{id}
   */
  putTeamsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/teams/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/teams/{id}
   */
  deleteTeamsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/teams/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/teams/{id}
   */
  patchTeamsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "member_count"?: number; "status"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/teams/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/transactions
   */
  getTransactions(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/transactions", {}, [], false, options)
  },

  /**
   * POST /api/transactions
   */
  postTransactions(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/transactions", {}, [], false, options)
  },

  /**
   * POST /api/transactions/bulk-delete
   */
  postTransactionsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/transactions/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/transactions/{id}
   */
  getTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/transactions/{id}
   */
  putTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/transactions/{id}
   */
  deleteTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/transactions/{id}
   */
  patchTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/usage-events
   */
  getUsageEvents(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "meter": "contacts" | "email_sends" | "sms_segments" | "ai_generations" | "storage_bytes"; "quantity": number; "idempotency_key": string; "metadata"?: unknown; "occurred_at": unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/usage-events", {}, [], false, options)
  },

  /**
   * GET /api/usage-events/{id}
   */
  getUsageEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "meter": "contacts" | "email_sends" | "sms_segments" | "ai_generations" | "storage_bytes"; "quantity": number; "idempotency_key": string; "metadata"?: unknown; "occurred_at": unknown; "team_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/usage-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/users
   */
  getUsers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "avatar"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/users", {}, [], false, options)
  },

  /**
   * POST /api/users
   */
  postUsers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "avatar"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/users", {}, [], false, options)
  },

  /**
   * GET /api/users/{id}
   */
  getUsersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "avatar"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/users/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/waitlist-products
   */
  getWaitlistProducts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/waitlist-products", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-products
   */
  postWaitlistProducts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/waitlist-products", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-products/bulk-delete
   */
  postWaitlistProductsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/waitlist-products/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/waitlist-products/{id}
   */
  getWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/waitlist-products/{id}
   */
  putWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/waitlist-products/{id}
   */
  deleteWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/waitlist-products/{id}
   */
  patchWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/waitlist-restaurants
   */
  getWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/waitlist-restaurants", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-restaurants
   */
  postWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/waitlist-restaurants", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-restaurants/bulk-delete
   */
  postWaitlistRestaurantsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/waitlist-restaurants/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/waitlist-restaurants/{id}
   */
  getWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/waitlist-restaurants/{id}
   */
  putWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/waitlist-restaurants/{id}
   */
  deleteWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/waitlist-restaurants/{id}
   */
  patchWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/websockets
   */
  getWebsockets(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/websockets", {}, [], false, options)
  },

  /**
   * POST /api/websockets
   */
  postWebsockets(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/websockets", {}, [], false, options)
  },

  /**
   * GET /api/websockets/{id}
   */
  getWebsocketsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/websockets/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /locale/{locale}
   */
  getLocaleLocale(input: { "locale": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/locale/{locale}", input ?? {}, [], false, options)
  },

  /**
   * GET /robots.txt
   */
  getRobotsTxt(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/robots.txt", {}, [], false, options)
  },

  /**
   * POST /webhooks/email/mailgun
   */
  postWebhooksEmailMailgun(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/webhooks/email/mailgun", {}, [], false, options)
  },

  /**
   * POST /webhooks/email/postmark
   */
  postWebhooksEmailPostmark(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/webhooks/email/postmark", {}, [], false, options)
  },

  /**
   * POST /webhooks/email/sendgrid
   */
  postWebhooksEmailSendgrid(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/webhooks/email/sendgrid", {}, [], false, options)
  },

  /**
   * POST /webhooks/email/ses
   */
  postWebhooksEmailSes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/webhooks/email/ses", {}, [], false, options)
  },
  }
}

export type Client = ReturnType<typeof createClient>
