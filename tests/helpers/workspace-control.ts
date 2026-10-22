import assert from 'node:assert/strict'
import type { BrowserControlAction } from './browser-operation'
import { observeBrowserOperation } from './browser-operation'

/** The driver's private fixture control transport, with no credential logging. */
export async function requestWorkspaceControl(context: { url: string, control: string }, action: BrowserControlAction): Promise<unknown> {
  const response = await observeBrowserOperation(`control-${action}-fetch`, () => fetch(`${context.url}/__fixture/${action}`, { method: 'GET', headers: { 'x-fixture-control': context.control }, signal: AbortSignal.timeout(5000) }))
  assert(response.ok, `Private fixture control must succeed: ${action}, ${response.status}`)
  return observeBrowserOperation(`control-${action}-json`, () => response.json())
}
