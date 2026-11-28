import assert from 'node:assert/strict'
import { click, launch, navigate, waitFor } from '@stacksjs/testing/browser'

const [siteUrl] = process.argv.slice(2)
assert(siteUrl, 'Supply the frontend URL printed by ./buddy dev')
const base = new URL(siteUrl)
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol), 'Use a local Drone frontend')
const { cdp, close } = await launch({ shared: false, viewport: { width: 375, height: 844, mobile: true } })

const visibleText = (selector: string) => cdp.evaluate<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`)

async function waitForText(selector: string, expected: string) {
  await waitFor(async () => (await visibleText(selector))?.includes(expected), 15000, { label: `${selector}: ${expected}` })
}

async function setField(selector: string, value: string) {
  await cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    field.value = ${JSON.stringify(value)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    if (field.value !== ${JSON.stringify(value)}) throw new Error('Field did not accept the test value')
  })()`)
}

async function checkPage() {
  assert.deepEqual(cdp.errors, [])
  assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'Page must fit a 375 px viewport')
}

try {
  assert(await navigate(cdp, new URL('/mapping', base).href), 'Mapping page must load')
  await click(cdp, { selector: 'button', text: 'Run survey scenario' })
  await click(cdp, { selector: 'button', text: 'End of recording' })
  await waitForText('[data-mapping-outcome]', 'Recording outcome: completed')
  await waitForText('[data-mapping-outcome]', 'Modeled board neutral: yes')
  await waitForText('[data-mapping-quality]', 'complete-collection')
  await waitForText('[data-mapping-photo]', '.png')
  await checkPage()
  console.log('PASS mapping receipt and acknowledged photo on the rendered survey page')

  assert(await navigate(cdp, new URL('/agriculture', base).href), 'Agriculture page must load')
  await click(cdp, { selector: 'button', text: 'Run scouting route' })
  await waitForText('[data-agriculture-status]', 'completed')
  await waitForText('[data-agriculture-captures]', '32')
  assert.equal(await cdp.evaluate('document.querySelectorAll("[aria-labelledby=agriculture-parcels] tbody tr").length'), 2)
  await waitFor(() => cdp.evaluate('Array.from(document.querySelectorAll("main img")).filter(image => image.complete && image.naturalWidth > 0).length === 2'), 5000, { label: 'Decoded sampling layer and visible source image' })
  await click(cdp, { selector: 'button', text: 'Clear field observations' })
  assert.equal(await visibleText('[data-agriculture-status]'), null)
  await click(cdp, { selector: 'button', text: 'Run scouting route' })
  await waitForText('[data-agriculture-captures]', '32')

  await setField('#agriculture-frame', 'photo-0016')
  await setField('#agriculture-animal', 'selected-light-animal')
  await setField('#agriculture-observer', 'test-operator')
  await setField('#agriculture-pixel-x', '60')
  await setField('#agriculture-pixel-y', '33')
  await setField('#agriculture-note', 'Operator-selected example')
  await click(cdp, { selector: 'button[type=submit]', text: 'Record selected animal' })
  await waitForText('[data-agriculture-observation]', 'selected-light-animal / test-operator')
  await waitForText('[aria-labelledby=agriculture-livestock] ol', 'Original capture photo-0016, pixel 60, 33.')
  await setField('#agriculture-frame', 'photo-0001')
  await waitFor(() => cdp.evaluate('!document.querySelector("[data-agriculture-observation]")'), 5000, { label: 'Observation is absent from a different capture' })
  await setField('#agriculture-frame', 'photo-0016')
  await waitForText('[data-agriculture-observation]', 'selected-light-animal / test-operator')
  await checkPage()
  console.log('PASS nominal crop scouting, parcel report and source-bound animal observation')

  await setField('#agriculture-scenario', 'band-skew')
  await click(cdp, { selector: 'button', text: 'Run scouting route' })
  await waitForText('[data-agriculture-status]', 'aborted / agriculture-band-synchronization')
  assert.equal(await visibleText('[data-agriculture-captures]'), '1')
  const missing = await cdp.evaluate<number[]>('Array.from(document.querySelectorAll("[aria-labelledby=agriculture-parcels] tbody tr"), row => Number(row.cells[3].textContent))')
  assert.equal(missing.length, 2)
  assert(missing.some(area => area > 0), 'An unobserved area must remain visible in the parcel report')
  assert.equal(await visibleText('[data-agriculture-observation]'), null)
  await checkPage()
  console.log('PASS band synchronization abort and missing parcel support on the rendered page')

  assert(await navigate(cdp, new URL('/application', base).href), 'Application page must load')
  const modeledEmission = '[aria-labelledby=application-result] dd:first-of-type'
  const closure = '[aria-labelledby=application-closure] > p'
  await click(cdp, { selector: 'button', text: 'Run modeled route' })
  await waitForText('#application-result', 'dry-completed')
  assert.equal(Number.parseFloat((await visibleText(modeledEmission)) ?? ''), 0, 'Default dry mode must emit zero water')

  await setField('#application-mode', 'apply')
  await setField('#application-authority', 'grant')
  await click(cdp, { selector: 'button', text: 'Run modeled route' })
  await waitFor(async () => await visibleText('#application-result') === 'completed / stopped', 15000, { label: 'Authorized nominal application completes' })
  assert(Number.parseFloat((await visibleText(modeledEmission)) ?? '') > 0, 'The authorized water model must emit water')
  await waitForText(closure, 'Modeled closure verified in the independent tail')
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector("[aria-labelledby=application-dose] img")?.naturalWidth)'), 5000, { label: 'Decoded dose map' })

  await setField('#application-scenario', 'master-stuck')
  await click(cdp, { selector: 'button', text: 'Run modeled route' })
  await waitForText('#application-result', 'blocked / application-barrier-position-disagreement')
  await waitForText(closure, 'Modeled closure unverified')
  await click(cdp, { selector: 'button', text: 'Independent tail end' })
  await waitForText('[aria-labelledby=application-rate]', 'No host observation at this epoch')
  assert(Number.parseFloat((await visibleText('[aria-labelledby=application-rate] dd')) ?? '') > 0, 'The independent tail must retain model flow after failed closure')
  await checkPage()
  console.log('PASS water dry run, authorized dose map and unverified shutdown on the rendered application page')
}
finally {
  await close()
}
