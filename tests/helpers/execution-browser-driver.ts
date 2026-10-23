import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { startWorkspaceBrowser } from './workspace-browser'
import { settleExecutionDiagnostics } from './execution-diagnostics'

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
let diagnosticPage: Awaited<ReturnType<typeof browser.page>> | undefined
let startBaseline: number | null = null
async function failureDiagnostics() {
  const abort = new AbortController()
  try {
    const snapshot = async () => {
      const response = await fetch(`${data.url}/__fixture/diagnostics`, { headers: { 'x-fixture-control': data.control }, signal: abort.signal })
      if (!response.ok) return { available: false }
      // The private fixture constructs only closed scalars and checks its own byte ceiling.
      return response.json()
    }
    const dom = diagnosticPage ? diagnosticPage.evaluate(`(() => {
      const selected = (selector, allowed) => {
        const value = document.querySelector(selector)?.textContent?.trim();
        return allowed.includes(value) ? value : null;
      };
      const start = document.querySelector('[data-execution-start]'), admit = document.querySelector('[data-execution-admit]');
      return {
        workspaceStatus: selected('[data-workspace-status]', ['disconnected', 'connecting', 'synchronizing', 'current', 'reconnecting', 'refused']),
        executionPhase: selected('[data-execution-phase]', ['no current run', 'waiting-for-consumer', 'running', 'stopping', 'completed', 'canceled', 'failed', 'discarded']),
        hasExecutionId: !!document.querySelector('[data-execution-id]'), hasCompletion: !!document.querySelector('[data-execution-completion]'),
        hasSelectedSource: !!document.querySelector('[data-workspace-source]'),
        startDisabled: start ? start.disabled === true : null, admitDisabled: admit ? admit.disabled === true : null,
        hasSourceExists: !!document.querySelector('[data-execution-source-exists]'), hasExecutionError: !!document.querySelector('[data-execution-error]')
      };
    })()`) : Promise.resolve(null)
    const parts = await settleExecutionDiagnostics(snapshot(), dom)
    const base = {
      label: 'execution-browser-failure-diagnostics', phase, startBaseline,
      browserErrorCount: diagnosticPage?.errors.length ?? null,
      executionStartRequests: diagnosticPage ? diagnosticPage.requests.filter(request => request.method === 'POST' && request.url.endsWith('/workspace/execution')).length : null,
      admissionRequests: diagnosticPage ? diagnosticPage.requests.filter(request => request.method === 'POST' && request.url.endsWith('/workspace/execution/admission')).length : null,
    }
    const text = JSON.stringify({ ...base, ...parts })
    const bounded = Buffer.byteLength(text, 'utf8') <= 8192 ? text : JSON.stringify({ ...base, server: { available: false }, dom: null, byteBudgetExceeded: true })
    console.error(bounded)
    await writeFile(join(evidence, 'failure-diagnostics.json'), `${bounded}\n`, { mode: 0o600, flag: 'wx' })
  }
  catch { console.error(JSON.stringify({ label: 'execution-browser-failure-diagnostics', phase, available: false })) }
  finally {
    abort.abort()
    // The owned socket close rejects pending CDP commands and clears their timers in the existing helper.
    diagnosticPage?.close()
  }
}
try {
  mark('connect original owner')
  const first = await browser.page(`${data.url}/incidents`)
  diagnosticPage = first
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
  startBaseline = typeof baseline.startRequests === 'number' ? baseline.startRequests : null
  await first.fill('#execution-scenario', 'nominal'); await first.fill('#execution-seconds', '100')
  await first.click('Start synthetic run')
  mark('real nominal100 completion')
  // Consume the completed fields from the same authorized DOM frame that satisfies readiness.
  // A later evaluation could run after native renewal has correctly hidden private content.
  const completedView = `(() => {
    const status = document.querySelector('[data-workspace-status]')?.textContent.trim();
    const phase = document.querySelector('[data-execution-phase]')?.textContent.trim();
    const digest = document.querySelector('[data-execution-digest]')?.textContent.trim();
    const execution = document.querySelector('[data-execution-id]')?.textContent.trim();
    const originalSelected = document.querySelector('[data-workspace-source]')?.textContent.trim() === ${JSON.stringify(data.sourceDigest)};
    return status === 'current' && phase === 'completed' && !!document.querySelector('[data-execution-completion]') && /^[a-f0-9]{64}$/.test(digest || '') && !!execution && originalSelected ? { digest, execution } : false;
  })()`
  const completed = await first.wait<{ digest: string, execution: string }>(completedView, 'Actual Worker recording must complete', 40000)
  await control('before-admission')
  await control('hold-completion-read-renewal')
  await first.wait("!document.querySelector('[data-execution-completion]')", 'Native completion-read renewal clears private content')
  await control('release-workspace')
  const restored = await first.wait<typeof completed>(completedView, 'Fresh authorization must restore the same completed result')
  assert.deepEqual(restored, completed)
  const { digest } = completed
  await writeFile(join(evidence, 'completion-read-renewal.json'), `${JSON.stringify({ privateContentCleared: true, sameCompletedResultRestored: true, readinessFieldsReadAtomically: true })}\n`, { mode: 0o600, flag: 'wx' })
  await first.evaluate("document.querySelector('[data-execution-panel]').scrollIntoView()")
  await first.screenshot(join(evidence, 'execution-completed-desktop.png'))
  await first.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true })
  await first.evaluate("document.querySelector('[data-execution-id]').scrollIntoView()")
  await first.screenshot(join(evidence, 'execution-completed-mobile.png'), 375, 900)
  assert.equal(await first.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'), 0, 'Execution UUID and digest wrap at375px')
  mark('explicit source admission')
  await first.evaluate(`(() => {
    const probe = { samples: [], overflow: false };
    const sample = () => {
      const value = document.querySelector('[data-workspace-source]')?.textContent.trim();
      const selected = !value ? 'absent' : value === ${JSON.stringify(data.sourceDigest)} ? 'original' : 'other';
      if (probe.samples.at(-1) === selected) return;
      if (probe.samples.length >= 64) { probe.overflow = true; return; }
      probe.samples.push(selected);
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    sample(); globalThis.executionSourceProbe = { probe, stop: () => observer.disconnect() };
  })()`)
  await control('arm-pre-admission-renewal')
  // Force the ordinary refresh ordering that can also occur from the native poll.
  // The held read must leave the admission action available until this explicit click.
  await first.click('Refresh current records')
  let preAdmissionHeld = false
  for (let attempt = 0; attempt < 100 && !preAdmissionHeld; attempt++) { preAdmissionHeld = (await control('status')).preAdmissionHeldReads > 0; if (!preAdmissionHeld) await Bun.sleep(10) }
  assert(preAdmissionHeld, 'An ordinary native refresh must reach the read barrier before admission')
  assert.equal((await control('status')).preAdmissionRenewed, false, 'Holding an ordinary refresh never conceals authorization')
  await first.click('Admit completed source')
  await first.wait("document.querySelector('[data-workspace-status]')?.textContent.trim() === 'current' && document.querySelector('[data-execution-phase]')?.textContent.trim() === 'completed' && document.querySelector('[data-execution-admit]')?.disabled === true", 'The explicit admission decision must be pending while native reads are held')
  await control('renew-pre-admission-held-read')
  await first.wait("!document.querySelector('[data-workspace-source]') && !document.querySelector('[data-execution-completion]')", 'Native renewal clears private content during the admission read')
  await control('release-workspace')
  assert.deepEqual(await first.wait<typeof completed>(completedView, 'Fresh authorization restores completed execution after the canceled admission'), completed)
  const canceledDecision = await control('status')
  assert.equal(canceledDecision.preAdmissionRenewed, true)
  assert.equal(canceledDecision.preAdmissionHoldExpired, false, 'The controlled native renewal must complete within the original read bound')
  assert.equal(canceledDecision.admissionRequests, 0, 'Lost availability cancels the earlier decision before any admission POST')
  assert.equal(await first.evaluate("!!document.querySelector('[data-execution-source-exists]')"), false)
  await control('before-admission')
  mark('explicit source admission after fresh authorization')
  await first.click('Admit completed source')
  await first.wait("!!document.querySelector('[data-execution-source-exists]')", 'Explicit admission must refresh actual source catalog', 15000)
  const acceptedDecision = await control('status')
  assert.equal(acceptedDecision.admissionRequests, 1, 'Only the new explicit decision submits one admission POST')
  await writeFile(join(evidence, 'pre-admission-renewal.json'), `${JSON.stringify({ ordinaryRefreshHeldBeforeClick: preAdmissionHeld, pendingDecisionObservedBeforeRenewal: true, nativeRenewalObserved: canceledDecision.preAdmissionRenewed, postsAfterCanceledDecision: canceledDecision.admissionRequests, postsAfterFreshExplicitDecision: acceptedDecision.admissionRequests, originalSelectionRestored: true })}\n`, { mode: 0o600, flag: 'wx' })
  await control('verify-admitted')
  mark('fresh workspace after admission renewal')
  assert.equal(await first.evaluate("!!document.querySelector('[data-workspace-source]') || !!document.querySelector('[data-execution-completion]')"), false, 'Native renewal must clear private panes before fresh authorization')
  await control('release-workspace')
  await first.wait(`document.querySelector('[data-workspace-status]')?.textContent.trim() === 'current' && !!document.querySelector('[data-execution-source-exists]') && document.querySelector('[data-workspace-source]')?.textContent.trim() === ${JSON.stringify(data.sourceDigest)}`, 'Fresh authorization must restore the original selection after admission', 15000)
  const selections = await first.evaluate<{ samples: string[], overflow: boolean }>('(() => { globalThis.executionSourceProbe.stop(); return globalThis.executionSourceProbe.probe; })()')
  assert.equal(selections.overflow, false, 'The complete bounded selection history must be available')
  assert(selections.samples.includes('absent'), 'The actual native renewal must hide selected imagery')
  assert.equal(selections.samples.at(-1), 'original')
  assert(selections.samples.every(value => value === 'original' || value === 'absent'), 'Admission must never select the new source, including during renewal')
  await writeFile(join(evidence, 'admission-renewal.json'), `${JSON.stringify(selections)}\n`, { mode: 0o600, flag: 'wx' })
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
catch (error) {
  console.error(`Execution browser original failure at ${phase}:`, error instanceof Error ? error.message : 'unknown failure')
  try { await failureDiagnostics() }
  catch { /* Keep the exact original failure even if diagnostic cleanup is unavailable. */ }
  throw error
}
finally { clearTimeout(watchdog); await browser.close() }
