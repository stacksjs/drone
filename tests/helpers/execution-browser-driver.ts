import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { startWorkspaceBrowser } from './workspace-browser'

// This driver owns only browser transport. Native credentials stay in a private fixture file.
const root = process.cwd()
assert(basename(root).startsWith('drone-incident-access-'))
const data = JSON.parse(await readFile(join(root, 'execution-credentials.json'), 'utf8')) as { url: string, key: string, sourceDigest: string, token: string, control: string }
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(data.url))
const control = async (action: string): Promise<any> => {
  const response = await fetch(`${data.url}/__fixture/${action}`, { headers: { 'x-fixture-control': data.control }, signal: AbortSignal.timeout(5000) })
  assert(response.ok, `Private execution fixture control must succeed: ${action}, ${response.status}`)
  return response.json()
}
const browser = await startWorkspaceBrowser(root)
const evidence = process.env.EXECUTION_BROWSER_EVIDENCE ?? join(root, 'execution-evidence')
await mkdir(evidence, { recursive: true })
let phase = 'initialization'
const mark = (next: string) => { phase = next; console.log(`Execution browser phase: ${next}`) }
const watchdog = setTimeout(() => { console.error('Execution browser watchdog expired'); void browser.close().finally(() => process.exit(1)) }, 85000)
try {
  mark('connect original owner')
  const first = await browser.page(`${data.url}/incidents`)
  const connect = async (page: typeof first, credential: string) => {
    await page.fill('#incident-key', data.key); await page.fill('#incident-token', credential); await page.click('Connect incident')
    await page.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'current'", 'Native execution owner must connect')
    assert.equal(await page.evaluate("(document.querySelector('#incident-token')?.value ?? '') === ''"), true)
  }
  await connect(first, data.token)
  await first.fill('#incident-source', data.sourceDigest); await first.click('Open source')
  await first.wait("!!document.querySelector('[data-workspace-source]')", 'Existing explicit source must render')
  await first.fill('#incident-note', 'Unsent observation before execution')
  mark('start accepted-response binding')
  await first.click('Start synthetic run')
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) { ready = (await control('status')).startResponseReady; if (!ready) await Bun.sleep(25) }
  assert(ready, 'Actual accepted POST must reach the delayed response seam')
  await first.fill('#execution-scenario', 'camera-loss'); await first.fill('#execution-seconds', '120')
  await first.fill('#incident-note', 'Later unsent observation survives execution success')
  await control('release-start')
  await first.wait("!!document.querySelector('[data-execution-event]')", 'A genuine live producer event must render')
  // The earlier native chunk is already rendered before a later owner transaction is held.
  mark('live producer before-return oracle')
  await control('arm-before-return')
  let held = false
  for (let attempt = 0; attempt < 100 && !held; attempt++) { held = (await control('status')).held; if (!held) await Bun.sleep(10) }
  assert(held, 'A later real original-owner credit check must be held')
  assert.equal(await first.evaluate("!!document.querySelector('[data-execution-event]')"), true, 'Earlier genuine producer progress remains rendered during the hold')
  await control('before-return') // server reads real Atomics words without SQL, then releases
  assert.equal(await first.evaluate("document.querySelector('#execution-scenario')?.value"), 'camera-loss')
  assert.equal(await first.evaluate("document.querySelector('#execution-seconds')?.value"), '120')
  assert.equal(await first.evaluate("document.querySelector('#incident-note')?.value"), 'Later unsent observation survives execution success')
  const runId = await first.evaluate<string>("document.querySelector('[data-execution-id]')?.textContent.trim()")
  const baseline = await control('status')
  await first.evaluate("document.querySelector('[data-execution-panel]').scrollIntoView()")
  await first.screenshot(join(evidence, 'execution-live-desktop.png'))
  mark('native GET renewal')
  await control('release-and-renew')
  let renewed = false
  for (let attempt = 0; attempt < 150 && !renewed; attempt++) { renewed = (await control('status')).streamStarts > baseline.streamStarts; if (!renewed) await Bun.sleep(25) }
  assert(renewed, 'The native STX GET stream must reconnect after a real connection ends')
  assert.equal((await control('status')).startRequests, 1, 'GET renewal never reexecutes the POST')
  assert.equal(await first.evaluate("document.querySelector('[data-execution-id]')?.textContent.trim()"), runId)
  mark('cooperative stop')
  await first.click('Stop synthetic run')
  await first.wait("document.querySelector('[data-execution-phase]')?.textContent.trim() === 'canceled' && document.querySelector('[data-execution-panel]')?.textContent.includes('producer finished')", 'Real cooperative producer cancellation must finish', 10000)
  assert.equal(await first.evaluate("!!document.querySelector('[data-execution-completion]')"), false)
  mark('finished result discard')
  await first.click('Discard temporary result')
  await first.wait("!document.querySelector('[data-execution-id]') && !document.querySelector('[data-execution-start]')?.disabled", 'Acknowledged finished discard releases this caller')
  await control('before-admission')
  await first.fill('#execution-scenario', 'nominal'); await first.fill('#execution-seconds', '100')
  await first.click('Start synthetic run')
  mark('real nominal100 completion')
  await first.wait("document.querySelector('[data-execution-phase]')?.textContent.trim() === 'completed' && !!document.querySelector('[data-execution-completion]')", 'Actual Worker recording must complete', 40000)
  await control('before-admission')
  const digest = await first.evaluate<string>("document.querySelector('[data-execution-digest]')?.textContent.trim()")
  assert(/^[a-f0-9]{64}$/.test(digest))
  assert.equal(await first.evaluate("document.querySelector('[data-workspace-source]')?.textContent.trim()"), data.sourceDigest, 'Completion cannot change selected imagery')
  await first.evaluate("document.querySelector('[data-execution-panel]').scrollIntoView()")
  await first.screenshot(join(evidence, 'execution-completed-desktop.png'))
  await first.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true })
  await first.evaluate("document.querySelector('[data-execution-id]').scrollIntoView()")
  await first.screenshot(join(evidence, 'execution-completed-mobile.png'), 375, 900)
  assert.equal(await first.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'), 0, 'Execution UUID and digest wrap at375px')
  mark('explicit source admission')
  await first.click('Admit completed source')
  await first.wait("!!document.querySelector('[data-execution-source-exists]')", 'Explicit admission must refresh actual source catalog', 15000)
  await control('verify-admitted')
  assert.equal(await first.evaluate("document.querySelector('[data-workspace-source]')?.textContent.trim()"), data.sourceDigest, 'Admission cannot select its new source')
  assert.equal(await first.evaluate("document.querySelector('#incident-note')?.value"), 'Later unsent observation survives execution success')
  mark('read-only credential')
  const { token } = await control('read-only')
  const readOnly = await browser.page(`${data.url}/incidents`)
  await connect(readOnly, token)
  assert.equal(await readOnly.evaluate("!!document.querySelector('[data-execution-start]') && document.querySelector('[data-execution-start]').disabled"), true, 'Existing read-only mutation control is genuinely disabled')
  assert.equal(await readOnly.evaluate("!!document.querySelector('[data-execution-id]')"), false)
  for (const page of [first, readOnly]) {
    assert.deepEqual(await page.evaluate('({local:localStorage.length,session:sessionStorage.length})'), { local: 0, session: 0 })
    assert.deepEqual(page.errors, [])
    for (const request of page.requests) assert(!request.url.includes(data.token) && !request.body.includes(data.token) && !request.url.includes(token) && !request.body.includes(token))
  }
  assert.equal(first.requests.filter(request => request.method === 'POST' && request.url.endsWith('/workspace/execution')).length, 2)
  mark('actual token revocation')
  await control('revoke')
  await first.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'refused'", 'Revocation must clear private execution content', 16000)
  assert.equal(await first.evaluate("!!document.querySelector('[data-execution-id]') || document.body.textContent.includes(" + JSON.stringify(digest) + ")"), false)
  console.log('PASS actual execution browser: native live-before-return/GET renewal/stop/completion/explicit admission/read-only/revocation')
}
catch (error) { console.error(`Execution browser original failure at ${phase}:`, error instanceof Error ? error.message : 'unknown failure'); throw error }
finally { clearTimeout(watchdog); await browser.close() }
