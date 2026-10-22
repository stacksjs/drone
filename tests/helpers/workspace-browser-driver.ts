import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { startWorkspaceBrowser } from './workspace-browser'
import type { BrowserControlAction } from './browser-operation'
import { requestWorkspaceControl } from './workspace-control'

// Controller is isolated from native Auth/SQLite and reads owner-only fixture credentials.
const root = process.cwd()
assert(basename(root).startsWith('drone-incident-access-'))
const data = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8')) as { url: string, key: string, sourceDigest: string, senderToken: string, recipientToken: string, recipientId: number, control: string, capture: { id: string, width: number }, pixel: number }
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(data.url))
const control = async (action: BrowserControlAction): Promise<any> => requestWorkspaceControl(data, action)
const browser = await startWorkspaceBrowser(root)
if (process.env.WORKSPACE_BROWSER_STARTUP_ONLY === 'true') {
  await browser.close()
  console.log('PASS actual workspace startup-only control')
}
else {
const evidence = process.env.WORKSPACE_BROWSER_EVIDENCE ?? join(root, 'evidence')
await mkdir(evidence, { recursive: true })
const watchdog = setTimeout(() => { console.error('QA isolated browser watchdog expired'); void browser.close().finally(() => process.exit(1)) }, 85000)
try {
  console.log('QA browser started; checking no-JavaScript fallback')
  const unavailable = await browser.page(`${data.url}/incidents`, false)
  await unavailable.fill('#incident-key', data.key); await unavailable.fill('#incident-token', data.senderToken)
  await unavailable.click('Connect incident'); await Bun.sleep(100)
  assert(unavailable.requests.some(request => request.method === 'POST'), 'Actual no-JavaScript browser submission must use POST')
  for (const request of unavailable.requests) assert(!request.url.includes(data.senderToken) && !request.body.includes(data.senderToken), 'Actual browser fallback must omit credentials from URL and body')
  unavailable.close()
  console.log('QA no-JavaScript fallback passed; connecting native account')
  const first = await browser.page(`${data.url}/incidents`)
  const connect = async (page: typeof first, credential: string) => {
    await page.fill('#incident-key', data.key); await page.fill('#incident-token', credential); await page.click('Connect incident')
    try { await page.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'current'", 'Real native account must connect') }
    catch (error) { await writeFile(join(evidence, 'connect-failure.json'), JSON.stringify({ errors: page.errors, status: await page.evaluate("document.querySelector('[data-workspace-status]')?.textContent") })); throw error }
    assert(await page.evaluate("(document.querySelector('#incident-token')?.value ?? '') === ''"), 'Credential field must be cleared without echoing its value')
  }
  await connect(first, data.senderToken)
  console.log('QA native sender connected')
  console.log('QA filling actual source selector'); await first.fill('#incident-source', data.sourceDigest); console.log('QA opening actual source'); await first.click('Open source'); console.log('QA waiting selected source')
  await first.wait("!!document.querySelector('[data-workspace-source]')", 'Explicit selected source must render')
  console.log('QA loading actual imagery'); await first.click('Read verified source imagery')
  await first.wait("document.querySelectorAll('#incident-capture option').length > 1", 'Actual source captures must load')
  const { capture, pixel } = data
  console.log('QA choosing actual capture'); await first.fill('#incident-capture', capture.id); await first.fill('#incident-x', String(pixel % capture.width)); await first.fill('#incident-y', String(Math.floor(pixel / capture.width)))
  await first.fill('#incident-note', 'Browser declaration <script>unsafe</script>')
  await first.fill('#incident-uncertainty', 'Unsigned source, unresolved synthetic evidence')
  await first.click('Record observation')
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) { ready = (await control('status')).releaseReady; if (!ready) await Bun.sleep(50) }
  assert(ready, 'Actual committed response must reach release seam')
  await first.fill('#incident-note', 'Later unsent human edit survives earlier success')
  await control('release')
  await first.wait("document.body.textContent.includes('Browser declaration <script>unsafe</script>')", 'Actual observation must commit and render escaped text')
  assert.equal(await first.evaluate("document.querySelector('#incident-note')?.value"), 'Later unsent human edit survives earlier success')
  assert.equal(await first.evaluate("document.querySelectorAll('script').length > 0 && typeof unsafe === 'undefined'"), true)
  await first.fill('#incident-note', 'Second browser original for target binding')
  await first.fill('#incident-uncertainty', 'Second original uncertainty remains distinct')
  await first.click('Record observation')
  await first.wait("document.querySelectorAll('[data-workspace-note]').length === 2 && document.querySelector('#incident-note')?.value === ''", 'Second actual original must commit')
  await first.screenshot(join(evidence, 'workspace-connected-desktop.png'))
  console.log('QA sender observation committed; opening recipient tab')
  const second = await browser.page(`${data.url}/incidents`)
  console.log('QA recipient tab ready; connecting'); await connect(second, data.recipientToken); console.log('QA recipient connected')
  console.log('QA recipient selecting source'); await second.fill('#incident-source', data.sourceDigest); await second.click('Open source')
  await second.wait("document.body.textContent.includes('Browser declaration <script>unsafe</script>')", 'Recipient reads committed observation')
  console.log('QA recipient opening review context'); await second.click('Open original observation and reviews')
  await second.wait("!!document.querySelector('#incident-review-note')", 'Actual review context must load')
  await second.fill('#incident-review-note', 'Draft belongs only to the first original')
  await second.evaluate("[...document.querySelectorAll('button')].filter(value => value.textContent.trim() === 'Open original observation and reviews')[1].click()")
  await second.wait("document.querySelector('#incident-review')?.parentElement.textContent.includes('Second browser original for target binding')", 'Explicit second target must load')
  assert.equal(await second.evaluate("document.querySelector('#incident-review-note')?.value"), '', 'Changing original must clear the former review draft')
  await second.fill('#incident-review-note', 'Browser explicit review remains unresolved')
  console.log('QA recipient appending review'); await second.click('Append review')
  await second.wait("document.body.textContent.includes('Browser explicit review remains unresolved')", 'Native review must commit')
  await first.wait("document.body.textContent.includes('Browser explicit review remains unresolved')", 'Content-free native invalidation must refresh sender')
  console.log('QA review committed and delivered; offering handover'); await first.fill('#incident-recipient', `${data.recipientId}:reviewer:1`)
  await first.click('Offer coordination')
  await second.wait("!!document.querySelector('#incident-acknowledgement')", 'Native offer must become actionable for recipient')
  await second.evaluate("document.querySelector('#incident-handover').scrollIntoView()")
  await second.screenshot(join(evidence, 'workspace-handover-desktop.png'))
  await second.screenshot(join(evidence, 'workspace-handover-mobile.png'), 375, 900)
  assert.equal(await second.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'), 0, 'Pending offer identifiers and acknowledgement must wrap on mobile')
  await second.evaluate("document.querySelector('#incident-acknowledgement').click()")
  console.log('QA accepting actual handover'); await second.click('Accept coordination')
  await second.wait("document.body.textContent.includes('coordinator') && !document.querySelector('#incident-acknowledgement')", 'Native handover acceptance must update authority')
  // A long unsubmitted note survives the normal bounded 30-second stream renewal.
  await second.fill('#incident-note', 'Human draft survives normal stream renewal')
  console.log('QA handover committed; awaiting 30s stream renewal')
  const baseline = await control('status')
  const waitStart = Date.now()
  await Bun.sleep(33000)
  console.log(`QA driver33s timer drift ms: ${Date.now() - waitStart - 33000}`)
  const status = await control('status')
  console.log(`QA actual native recipient streams: ${status.recipientStreams}`)
  await second.checkLiveness()
  assert(status.recipientStreams > baseline.recipientStreams, 'Actual native stream must reconnect during the measured lifetime window')
  const starts = status.recipientStreamStarts as number[]
  assert(starts.slice(baseline.recipientStreams).some((start, index) => start >= waitStart && start - starts[baseline.recipientStreams + index - 1]! >= 30000), 'Measured renewal must follow an actual default30s stream lifetime')
  await second.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'current'", 'Normal stream lifetime must reconnect with current authority')
  assert.equal(await second.evaluate("document.querySelector('#incident-note')?.value"), 'Human draft survives normal stream renewal')
  await second.evaluate('scrollTo(0,0)')
  await second.screenshot(join(evidence, 'workspace-connected-mobile.png'), 375, 900)
  assert.equal(await second.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'), 0)
  for (const page of [first, second]) {
    assert.deepEqual(await page.evaluate('({local:localStorage.length,session:sessionStorage.length})'), { local: 0, session: 0 })
    assert.deepEqual(page.errors, [])
  }
  await control('verify')
  const { token: readOnlyToken } = await control('read-only')
  const readOnly = await browser.page(`${data.url}/incidents`)
  await connect(readOnly, readOnlyToken)
  await readOnly.wait("document.body.textContent.includes('Read-only credential. Mutation controls are unavailable.')", 'Actual read-only native credential must disable mutation controls')
  await readOnly.fill('#incident-source', data.sourceDigest); await readOnly.click('Open source')
  await readOnly.wait("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Record observation')", 'Read-only observation control must actually exist')
  await readOnly.click('Read verified source imagery')
  await readOnly.wait("document.querySelectorAll('#incident-capture option').length > 1", 'Read-only credential may inspect actual source pixels')
  await readOnly.fill('#incident-capture', capture.id); await readOnly.fill('#incident-x', String(pixel % capture.width)); await readOnly.fill('#incident-y', String(Math.floor(pixel / capture.width)))
  assert.equal(await readOnly.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Record observation')?.disabled"), true)
  assert.equal(await readOnly.evaluate("[...document.querySelectorAll('button')].some(button => ['Record observation','Append review','Offer coordination','Accept coordination','Decline offer','Cancel offer','Retry exact handover request'].includes(button.textContent.trim()) && !button.disabled)"), false)
  await control('revoke')
  await second.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'refused'", 'Revoked credential must clear private panes', 16000)
  assert.equal(await second.evaluate("document.querySelector('#incident-note')?.value ?? ''"), '')
  assert.equal(await second.evaluate("document.body.textContent.includes('Browser declaration <script>unsafe</script>')"), false)
  console.log('PASS actual compiled workspace browser: native connect/source/observation/review/handover/30s renewal/revocation')
}
catch (error) { console.error('QA browser failure:', error instanceof Error ? error.message : 'unknown'); throw error }
finally { clearTimeout(watchdog); await browser.close() }
}
