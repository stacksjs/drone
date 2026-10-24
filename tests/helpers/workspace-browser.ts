import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { observeBrowserOperation } from './browser-operation'
import { browserFileErrorCode, retainBrowserLaunchEvidence } from './browser-launch-evidence'
import type { BrowserLaunchObservation } from './browser-launch-evidence'
import { createBrowserStartupObserver } from './browser-startup-process'
import { createLinuxStartupObservation } from './browser-startup-linux'

/** Dependency-free CDP, with a fresh profile. Credentials never enter command arguments. */
async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Browser socket timed out')) }, 5000)
    socket.onopen = () => { clearTimeout(timeout); resolve() }
    socket.onerror = socket.onclose = () => { clearTimeout(timeout); reject(new Error('Browser socket unavailable')) }
  })
  return socket
}

export async function startWorkspaceBrowser(root: string) {
  const profile = join(root, 'browser-profile')
  await mkdir(profile)
  const child = Bun.spawn([process.env.BROWSE_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', '--disable-dev-shm-usage', '--disable-extensions', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(root, 'chrome.log')) })
  const started = Date.now()
  const began = performance.now()
  const startup = createBrowserStartupObserver(child.pid, began, process.platform === 'linux' ? createLinuxStartupObservation(child.pid, profile, began) : null)
  let closing = false
  const launch: BrowserLaunchObservation['launch'] = { pid: child.pid, exitObserved: false, settledExitCode: null, signalCode: null, exitObservedBeforeCleanup: false, cleanupRequested: false, exitElapsedMs: null }
  const portProbe: BrowserLaunchObservation['portProbe'] = { attempts: 0, successfulReads: 0, failedReads: 0, lastReadError: null, discovered: false }
  let pageVisited = false
  const retain = (phase: BrowserLaunchObservation['phase']) => retainBrowserLaunchEvidence(root, { phase, elapsedMs: performance.now() - began, launch: { ...launch }, portProbe: { ...portProbe }, startup: startup.evidence() }, { startupStderr: !pageVisited, exportDirectory: process.env.WORKSPACE_BROWSER_EVIDENCE ?? process.env.EXECUTION_BROWSER_EVIDENCE })
  const cleanup = async () => {
    closing = true; launch.cleanupRequested = true
    if (child.exitCode === null) child.kill()
    await Promise.race([child.exited, Bun.sleep(2000)])
    if (!pageVisited) await startup.cleanupEnded()
  }
  void child.exited.then(code => {
    launch.exitObserved = true; launch.settledExitCode = code; launch.signalCode = child.signalCode; launch.exitObservedBeforeCleanup = !closing; launch.exitElapsedMs = performance.now() - began
    if (!closing) console.log(`QA isolated Chrome exited unexpectedly: ${code}, elapsedMs:${Date.now() - started}`)
  })
  let port = ''
  for (let attempt = 0; attempt < 400; attempt++) {
    startup.tick()
    portProbe.attempts++
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(value => { portProbe.successfulReads++; portProbe.lastReadError = null; return value.split('\n')[0]! }).catch(error => { portProbe.failedReads++; portProbe.lastReadError = browserFileErrorCode(error); return '' })
    if (port) { portProbe.discovered = true; break }
    await Bun.sleep(50)
  }
  await startup.finishDiscovery()
  if (!port) { await cleanup(); await retain('startup-unavailable'); throw new Error('Fresh browser must start') }
  // Keep a browser-level session, as well as page sessions, for the owned lifecycle.
  let browserSocket: WebSocket
  try {
    const response = await observeBrowserOperation('version-fetch', () => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }))
    const version = await observeBrowserOperation('version-json', () => response.json()) as { webSocketDebuggerUrl: string, Browser?: unknown }
    startup.recordVersion(version.Browser)
    browserSocket = await observeBrowserOperation('browser-socket', () => openSocket(version.webSocketDebuggerUrl))
  }
  catch (error) { await cleanup(); await retain('discovery-failed'); throw error }
  let browserSequence = 0
  browserSocket.onmessage = () => {}
  const keepAlive = setInterval(() => { if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify({ id: ++browserSequence, method: 'Browser.getVersion' })) }, 5000)
  const pages: Array<{ close: () => void }> = []
  return {
    async page(url: string, javascript = true) {
      pageVisited = true
      const response = await observeBrowserOperation('target-fetch', () => fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }))
      const target = await observeBrowserOperation('target-json', () => response.json()) as { webSocketDebuggerUrl: string }
      const socket = await observeBrowserOperation('page-socket', () => openSocket(target.webSocketDebuggerUrl))
      let sequence = 0, phase = 'initial page'
      const waiting = new Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>()
      const errors: string[] = []
      const requests: Array<{ method: string, url: string, body: string }> = []
      const send = <T = any>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => { const id = ++sequence; const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`Browser command timed out: ${method}, ${phase}`)) }, 10000); waiting.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } }); socket.send(JSON.stringify({ id, method, params })) })
      socket.onclose = () => { for (const pending of waiting.values()) pending.reject(new Error('Browser closed during command')); waiting.clear() }
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data))
        if (message.id) { const pending = waiting.get(message.id); waiting.delete(message.id); if (message.error) pending?.reject(new Error('Browser command failed')); else pending?.resolve(message.result) }
        if (message.method === 'Network.requestWillBeSent') { const request = message.params.request; requests.push({ method: request.method, url: request.url, body: request.postData ?? '' }) }
        if (message.method === 'Runtime.exceptionThrown') errors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).replace(/(https?:[^\s?]+)\?[^\s:]*/g, '$1?[redacted]'))
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push('Browser console error')
      }
      await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
      if (!javascript) await send('Emulation.setScriptExecutionDisabled', { value: true })
      const evaluate = async <T = any>(expression: string): Promise<T> => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        assert(!result.exceptionDetails, 'Browser evaluation must complete')
        return result.result.value as T
      }
      const page = {
        errors, requests, send, evaluate,
        async wait<T = boolean>(expression: string, message: string, timeout = 10000): Promise<T> {
          phase = message
          const end = Date.now() + timeout
          while (Date.now() < end) { const value = await evaluate<T | false>(expression); if (value) return value; await Bun.sleep(50) }
          throw new Error(message)
        },
        async checkLiveness() { phase = 'post-renewal liveness'; assert.equal(await evaluate('1'), 1) },
        async fill(selector: string, value: string) { phase = `field ${selector}`; await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw Error('Missing form field'); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); })()`) },
        async click(text: string) { phase = `action ${text}`; await evaluate(`(() => { const element = [...document.querySelectorAll('button')].find(value => value.textContent.trim() === ${JSON.stringify(text)} && !value.disabled); if (!element) throw Error('Missing enabled action'); element.click(); })()`) },
        async screenshot(path: string, width = 1280, height = 1000) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }); await Bun.sleep(100); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await Bun.write(path, Buffer.from(shot.data, 'base64')) },
        close() { socket.close() },
      }
      pages.push(page)
      await send('Page.navigate', { url })
      await page.wait(javascript ? "document.querySelector('#incident-key') !== null && document.querySelector('[data-workspace-status]')?.textContent.trim() === 'disconnected'" : "document.querySelector('#incident-key') !== null", 'Compiled workspace must initialize')
      return page
    },
    async close() { console.log(`QA browser.close requested, elapsedMs:${Date.now() - started}`); clearInterval(keepAlive); browserSocket.close(); for (const page of pages) page.close(); await cleanup(); await retain('closed') },
  }
}
