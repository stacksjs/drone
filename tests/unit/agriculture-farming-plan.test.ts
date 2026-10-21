import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { planFarmingObservation } from '../../resources/functions/drone/agriculture/farming-plan'

test('an explicit metric field produces a planning-only public preview', async () => {
  const input = readFileSync(new URL('../../examples/farming-plan.json', import.meta.url), 'utf8')
  const result = await planFarmingObservation(input)
  expect(result.version).toBe(1)
  expect(result.kind).toBe('farming-observation-planning-preview')
  expect(result.status).toBe('planned')
  expect(result.context).toEqual({ farmId: 17, fieldId: 29, declarationId: 'square-declaration-v1' })
  expect(Math.abs(result.plan.survey.areaM2 - 2.56)).toBeLessThanOrEqual(64 * Number.EPSILON * 2.56)
  expect(result.ownershipVerified).toBe(false)
  expect(result.geometryVerified).toBe(false)
  expect(result.observationPerformed).toBe(false)
  expect(result.dispatchPerformed).toBe(false)
  expect(result.physicalFlightEnabled).toBe(false)
})

type FarmingResult = Awaited<ReturnType<typeof planFarmingObservation>>
function farmingObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected fixture record')
  return value as Record<string, unknown>
}
function farmingArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected fixture array')
  return value
}
function farmingText(): string {
  const text = readFileSync(new URL('../../examples/farming-plan.json', import.meta.url), 'utf8')
  expect(Buffer.byteLength(text)).toBe(4745)
  expect(farmingSha(text)).toBe('3089a663542e7472ff22cc115e606344f431c2e2d7de39f27edabb3a7f5fa5f0')
  return text
}
function farmingRequest(): Record<string, unknown> { return farmingObject(JSON.parse(farmingText())) }
function farmingConfig(request: Record<string, unknown>) { return farmingObject(request.config) }
function farmingSurvey(request: Record<string, unknown>) { return farmingObject(farmingConfig(request).survey) }
function farmingSha(text: string): string { return new Bun.CryptoHasher('sha256').update(text).digest('hex') }
function farmingClose(actual: number, expected: number, factor: number): void {
  expect(Number.isFinite(actual)).toBe(true)
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(factor * Number.EPSILON * Math.max(1, Math.abs(expected)))
}
async function farmingRefusal(input: unknown, kind: typeof Error, message: string): Promise<void> {
  let failure: unknown
  try { await Reflect.apply(planFarmingObservation, undefined, [input]) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(kind)
  if (!(failure instanceof Error)) throw new Error('Public interface did not reject with an Error')
  expect(Object.getPrototypeOf(failure)).toBe(kind.prototype)
  expect(failure.message).toBe(message)
}
function farmingHole(): string {
  const request = farmingRequest(), config = farmingConfig(request), survey = farmingSurvey(request)
  request.requestId = 'farming-plan-hole-v1'
  farmingObject(request.context).declarationId = 'hole-declaration-v1'
  farmingObject(request.geometry).sourceReference = 'paper-hole-v1'
  config.id = survey.id = 'farming-hole-v1'
  survey.holes = [[[-.1, -.1], [.1, -.1], [.1, .1], [-.1, .1]]]
  return JSON.stringify(request) + '\n'
}
const farmingSurveyAssumptions = [
  'Collection only; no reconstruction or measured survey accuracy.',
  'Nadir planned pose with initial simulation north; absolute heading is not observed.',
  'Conservative central footprint square, certified lens derivative and declared terrain plane.',
  'AOI holes exclude imaging transects; connectors may cross holes and footprints may extend outside the AOI.',
  'Endurance estimate includes launch, return, transit and settling; wind and physical battery performance are unverified.',
]
function farmingFullPlan(text: string, result: FarmingResult, hole: boolean): void {
  const input = farmingObject(JSON.parse(text))
  expect(Object.keys(result).sort()).toEqual(['version', 'kind', 'operation', 'status', 'requestId', 'context', 'source', 'geometry', 'plan', 'ownershipVerified', 'geometryVerified', 'physicalFlightEnabled', 'observationPerformed', 'dispatchPerformed'].sort())
  expect(result.version).toBe(1); expect(result.kind).toBe('farming-observation-planning-preview')
  expect(result.operation).toBe('agriculture-observation-plan'); expect(result.status).toBe('planned')
  expect<unknown>(result.requestId).toBe(input.requestId); expect<unknown>(result.context).toEqual(input.context); expect<unknown>(result.geometry).toEqual(input.geometry)
  expect(result.source).toEqual({ sha256: farmingSha(text), byteLength: Buffer.byteLength(text), encoding: 'utf-8' })
  for (const flag of [result.ownershipVerified, result.geometryVerified, result.physicalFlightEnabled, result.observationPerformed, result.dispatchPerformed]) expect(flag).toBe(false)
  expect(Object.keys(result.plan).sort()).toEqual(['version', 'config', 'survey', 'assumptions'].sort())
  expect(result.plan.version).toBe(1); expect<unknown>(result.plan.config).toEqual(input.config)
  const s = result.plan.survey
  expect(Object.keys(s).sort()).toEqual(['version', 'config', 'areaM2', 'lanes', 'footprintM', 'gsdM', 'captureSpacingM', 'triggerIntervalMs', 'estimatedPhotos', 'distanceM', 'estimatedSeconds', 'requiredWh', 'assumptions'].sort())
  expect(s.version).toBe(1); expect<unknown>(s.config).toEqual(farmingSurvey(input))
  expect(s.assumptions).toEqual(farmingSurveyAssumptions)
  expect(result.plan.assumptions).toEqual([...farmingSurveyAssumptions,
    'Raw red/NIR counts share an explicitly registered optical grid; visible colours are not NIR measurements.',
    'Panel and irradiance declarations condition the reflectance calculation; physical calibration and agronomic accuracy are unverified.',
    'Parcel rectangles are clipped to the surveyed field and holes. Reports use area-weighted grid-centre samples, not a reconstructed orthomosaic.',
    'Animal labels require explicit operator-selected capture pixels and never establish automatic identity.',
  ])
  // Complete literal config equality includes retained panel epochs and camera timing in both copies.
  expect(result.plan.config.radiometry.panels.map(panel => panel.capturedAtMs)).toEqual([0, 0])
  expect(s.config.calibration.timing).toEqual({ clockUncertaintyMs: 1, maxSkewMs: 20, maxAgeMs: 100 })
  const lanes: [number[], number[], number][] = [
    [[-.8, -.64, -1.5], [.8, -.64, -1.5], 1.6],
    [[.8, -.32, -1.5], [-.8, -.32, -1.5], 1.6],
  ]
  if (hole) lanes.push([[ -.8, 0, -1.5], [-.1, 0, -1.5], .7], [[.1, 0, -1.5], [.8, 0, -1.5], .7])
  else lanes.push([[-.8, 0, -1.5], [.8, 0, -1.5], 1.6])
  lanes.push([[.8, .32, -1.5], [-.8, .32, -1.5], 1.6], [[-.8, .64, -1.5], [.8, .64, -1.5], 1.6])
  expect(s.lanes).toHaveLength(lanes.length)
  for (let i = 0; i < lanes.length; i++) {
    const actual = s.lanes[i]!, expected = lanes[i]!
    expect(Object.keys(actual).sort()).toEqual(['id', 'fromM', 'toM', 'lengthM', 'headingDeg'].sort())
    expect(actual.id).toBe(`lane-${i + 1}`); expect(actual.headingDeg).toBe(0)
    expect(actual.fromM).toHaveLength(3); expect(actual.toM).toHaveLength(3)
    for (let axis = 0; axis < 3; axis++) {
      farmingClose(actual.fromM[axis]!, expected[0][axis]!, 32)
      farmingClose(actual.toM[axis]!, expected[1][axis]!, 32)
    }
    farmingClose(actual.lengthM, expected[2], 64)
  }
  const width = 219 * Math.SQRT2 / 370, distance = 9.28 + 2 * Math.sqrt(3.2996)
  const seconds = distance / .4 + 36 + (hole ? 4 : 0)
  farmingClose(s.areaM2, hole ? 2.52 : 2.56, 64)
  expect(Object.keys(s.footprintM).sort()).toEqual(['along', 'across'].sort())
  farmingClose(s.footprintM.along, width, 64); farmingClose(s.footprintM.across, width, 64)
  farmingClose(s.gsdM, 73 / 1560, 64); farmingClose(s.captureSpacingM, .4 * width, 64)
  farmingClose(s.distanceM, distance, 128); farmingClose(s.estimatedSeconds, seconds, 256); farmingClose(s.requiredWh, seconds / 15, 256)
  expect(s.triggerIntervalMs).toBe(837); expect(s.estimatedPhotos).toBe(hole ? 32 : 30)
  expect(Buffer.byteLength(JSON.stringify(result) + '\n')).toBeLessThanOrEqual(524288)
}

for (const hole of [false, true]) {
  test(`complete independently worked farming ${hole ? 'hole' : 'nominal'} plan and all declared metadata`, async () => {
    const text = hole ? farmingHole() : farmingText()
    farmingFullPlan(text, await planFarmingObservation(text), hole)
  })
}

test('farming planning refuses nonprimitive inputs without caller coercion and malformed JSON', async () => {
  let reads = 0
  const poison = new Proxy({}, { get() { reads++; throw new Error('PRIVATE_COERCION') } })
  for (const value of [undefined, null, 0, false, [], {}, Object('{}'), poison, Symbol('private')]) await farmingRefusal(value, TypeError, 'farming-plan-input')
  expect(reads).toBe(0)
  for (const text of ['', '{', 'null', '[]', 'true', '0', '"text"', '{}', '{"version":NaN}']) await farmingRefusal(text, TypeError, 'farming-plan-input')
})

test('farming planning requires closed envelope context and geometry records', async () => {
  for (const key of ['version', 'operation', 'requestId', 'context', 'geometry', 'config']) {
    const request = farmingRequest(); delete request[key]
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
  const nested: [string, string[]][] = [['context', ['farmId', 'fieldId', 'declarationId']], ['geometry', ['frame', 'horizontalUnit', 'heightDatum', 'evidence', 'sourceReference']]]
  for (const [target, keys] of nested) for (const key of keys) {
    const request = farmingRequest(); delete farmingObject(request[target])[key]
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
  for (const target of ['root', 'context', 'geometry']) {
    const request = farmingRequest()
    farmingObject(target === 'root' ? request : request[target]).privateExtra = 'PRIVATE_FIELD'
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
  for (const key of ['context', 'geometry']) for (const value of [null, [], 1, 'record']) {
    const request = farmingRequest(); request[key] = value
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
})

test('farming planning enforces actual scalar types positive safe row ids and bounded identifiers', async () => {
  const cases: [string, string, unknown][] = [
    ['root', 'version', 2], ['root', 'version', '1'], ['root', 'operation', 1],
    ['root', 'requestId', ''], ['root', 'requestId', 'UPPER'], ['root', 'requestId', 'a b'], ['root', 'requestId', 'a'.repeat(65)], ['root', 'requestId', 1],
    ['context', 'farmId', 0], ['context', 'farmId', -1], ['context', 'farmId', 1.5], ['context', 'farmId', '17'], ['context', 'farmId', Number.MAX_SAFE_INTEGER + 1],
    ['context', 'fieldId', true], ['context', 'fieldId', 0], ['context', 'declarationId', 'Bad'], ['context', 'declarationId', null],
    ['geometry', 'sourceReference', ''], ['geometry', 'sourceReference', 'https://private.example/field'], ['geometry', 'sourceReference', 'a'.repeat(65)],
  ]
  for (const [target, key, value] of cases) {
    const request = farmingRequest(); farmingObject(target === 'root' ? request : request[target])[key] = value
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
  await farmingRefusal(farmingText().replace(/"farmId":\s*17/, '"farmId":1e999'), TypeError, 'farming-plan-input')
})

test('maximum permitted declared ids remain correlations without an ownership lookup', async () => {
  const request = farmingRequest(), context = farmingObject(request.context)
  request.requestId = 'a'.repeat(64); context.farmId = Number.MAX_SAFE_INTEGER; context.fieldId = 1; context.declarationId = 'd'.repeat(64)
  farmingObject(request.geometry).sourceReference = 's'.repeat(64)
  const text = JSON.stringify(request), result = await planFarmingObservation(text)
  expect<unknown>(result.requestId).toBe(request.requestId); expect<unknown>(result.context).toEqual(context)
  expect(result.geometry.sourceReference).toBe('s'.repeat(64)); expect(result.ownershipVerified).toBe(false)
  expect(result.source.sha256).toBe(farmingSha(text))
})

test('farming planning rejects unsupported reference units datums and evidence declarations', async () => {
  for (const [key, value] of [['frame', 'EPSG:4326'], ['horizontalUnit', 'degrees'], ['heightDatum', 'MSL'], ['evidence', 'surveyed']]) {
    const request = farmingRequest(); farmingObject(request.geometry)[key!] = value
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  }
})

const farmingMarketSlugs = ['targeted-weed-control', 'plant-disease-detection', 'pest-monitoring', 'precision-fertilisation', 'irrigation-analysis', 'yield-forecasting', 'field-mapping', 'wildlife-rescue', 'drone-seeding', 'frost-protection', 'pollination-support', 'livestock-and-fences', 'bird-deterrence', 'automated-herding', 'soil-compaction', 'sustainability-dashboard', 'drone-service', 'autonomous-network', 'field-assistant']
for (const operation of farmingMarketSlugs) {
  test(`marketed ${operation} is not an alias for the farming planning operation`, async () => {
    const request = farmingRequest(); request.operation = operation
    await farmingRefusal(JSON.stringify(request), TypeError, 'farming-plan-input')
  })
}

test('actual unsupported agriculture geometry calibration resources and endurance remain planner rejections', async () => {
  const mutations: ((request: Record<string, unknown>) => void)[] = [
    request => { request.config = null },
    request => { delete farmingConfig(request).gridResolutionM },
    request => { farmingConfig(request).privateExtra = 'PRIVATE_CONFIG' },
    request => { farmingSurvey(request).id = 'other-plan' },
    request => { farmingSurvey(request).boundary = [[-.8, -.8], [.8, .8], [.8, -.8], [-.8, .8]] },
    request => { farmingConfig(request).gridResolutionM = .001 },
    request => { farmingSurvey(request).boundary = [[-.9, -.9], [.9, -.9], [.9, .9], [-.9, .9]]; farmingConfig(request).gridResolutionM = .025 },
    request => { farmingObject(farmingArray(farmingConfig(request).parcels)[1]).boundsM = [-.5, -.5, .5, .5] },
    request => { farmingSurvey(request).heldOut = farmingArray(farmingSurvey(request).heldOut).slice(0, 2) },
    request => { farmingSurvey(request).maxGsdM = .001 },
    request => { farmingObject(farmingSurvey(request).power).availableWh = .1 },
    request => { farmingObject(farmingArray(farmingObject(farmingConfig(request).radiometry).bands)[0]).name = 'green' },
    request => { farmingObject(farmingArray(farmingObject(farmingConfig(request).radiometry).panels)[0]).capturedAtMs = -1 },
  ]
  for (const mutate of mutations) {
    const request = farmingRequest(); mutate(request)
    await farmingRefusal(JSON.stringify(request), Error, 'farming-plan-rejected')
  }
})

test('ordinary JSON whitespace and native last-key-wins retain exact original UTF8 identity', async () => {
  const compact = JSON.stringify(farmingRequest())
  const spaced = ' \n\t' + farmingText() + ' \r\n'
  const duplicate = '{"requestId":"obsolete",' + compact.slice(1)
  const nestedDuplicate = compact.replace('"context":{"farmId":17', '"context":{"farmId":0,"farmId":17')
  expect(nestedDuplicate).not.toBe(compact)
  const results = []
  for (const text of [compact, spaced, duplicate, nestedDuplicate]) {
    const result = await planFarmingObservation(text)
    expect(result.source).toEqual({ sha256: farmingSha(text), byteLength: Buffer.byteLength(text), encoding: 'utf-8' })
    expect(result.requestId).toBe('farming-plan-square-v1'); expect(result.context.farmId).toBe(17)
    expect<unknown>(result.plan.config).toEqual(farmingConfig(farmingRequest()))
    results.push(result.source.sha256)
  }
  expect(new Set(results).size).toBe(4)
})

test('exact ASCII UTF16 and UTF8 input ceiling is accepted and one code unit beyond is refused', async () => {
  const original = farmingText(), exact = original + ' '.repeat(262144 - original.length)
  expect(exact.length).toBe(262144); expect(Buffer.byteLength(exact)).toBe(262144)
  const result = await planFarmingObservation(exact)
  expect(result.source).toEqual({ sha256: farmingSha(exact), byteLength: 262144, encoding: 'utf-8' })
  await farmingRefusal(exact + ' ', RangeError, 'farming-plan-limit')
})

test('multibyte input reaches the UTF8 ceiling independently of UTF16 and one byte beyond fails', async () => {
  const request = farmingRequest()
  farmingObject(farmingArray(farmingSurvey(request).heldOut)[0]).id = 'é'
  const base = JSON.stringify(request)
  expect(Buffer.byteLength(base)).toBe(base.length + 1)
  const exact = base + ' '.repeat(262144 - Buffer.byteLength(base))
  expect(exact.length).toBe(262143); expect(Buffer.byteLength(exact)).toBe(262144)
  const result = await planFarmingObservation(exact)
  expect(result.source).toEqual({ sha256: farmingSha(exact), byteLength: 262144, encoding: 'utf-8' })
  expect((exact + ' ').length).toBe(262144)
  await farmingRefusal(exact + ' ', RangeError, 'farming-plan-limit')
})

test('raw unpaired surrogates and a leading BOM cannot be replacement-encoded or stripped', async () => {
  for (const code of [0xD800, 0xDC00]) {
    const raw = farmingText().replace('synthetic-survey-brown5', String.fromCharCode(code))
    await farmingRefusal(raw, TypeError, 'farming-plan-input')
  }
  await farmingRefusal('\uFEFF' + farmingText(), TypeError, 'farming-plan-input')
})

test('separate public planning calls own their nested records and never mutate the source declaration', async () => {
  const text = farmingText(), first = await planFarmingObservation(text), second = await planFarmingObservation(text)
  const before = JSON.stringify(second)
  expect(first).not.toBe(second); expect(first.plan.config).not.toBe(second.plan.config)
  first.context.farmId = 999; first.source.sha256 = 'f'.repeat(64); first.geometry.sourceReference = 'mutated'
  first.plan.config.parcels[0]!.boundsM[0] = -99
  first.plan.config.radiometry.panels[0]!.capturedAtMs = 999
  first.plan.survey.lanes[0]!.fromM[0] = 999
  expect(JSON.stringify(second)).toBe(before)
  expect(JSON.stringify(await planFarmingObservation(text))).toBe(before)
  expect(farmingText()).toBe(text)
})

function farmingOutputWitness(): string {
  const request = farmingRequest(), config = farmingConfig(request), survey = farmingSurvey(request)
  request.requestId = 'farming-plan-size-v1'; farmingObject(request.context).declarationId = 'size-declaration-v1'
  farmingObject(request.geometry).sourceReference = 'paper-size-bound-v1'; config.id = survey.id = 'farming-size-v1'
  survey.boundary = [[-.8, -21.25], [.8, -21.25], [.8, 21.25], [-.8, 21.25]]; survey.holes = []
  farmingObject(farmingArray(config.parcels)[0]).boundsM = [-.8, -21.25, 0, 21.25]
  farmingObject(farmingArray(config.parcels)[1]).boundsM = [0, -21.25, .8, 21.25]
  config.gridResolutionM = .5; farmingObject(survey.power).availableWh = 10000
  const heldOut = farmingArray(survey.heldOut), original = structuredClone(heldOut)
  expect(original).toHaveLength(6)
  for (let i = 0; i < 250; i++) {
    const sample = farmingObject(structuredClone(original[i % 6]))
    sample.id = `h${i.toString(16).padStart(3, '0')}`; heldOut.push(sample)
  }
  // One base measurement and one direct allocation, matching the independently assembled fixed bytes.
  const baseBytes = Buffer.byteLength(JSON.stringify(survey)); expect(baseBytes).toBe(22553)
  let remaining = 258000 - baseBytes
  for (let i = 0; i < 250; i++) {
    const take = Math.min(remaining, 1524), whole = Math.floor(take / 3), remainder = take % 3
    const suffix = '界'.repeat(whole) + (remainder === 1 ? 'a' : remainder === 2 ? '¢' : '')
    expect(suffix.length).toBeLessThanOrEqual(508); expect(Buffer.byteLength(suffix)).toBe(take)
    const sample = farmingObject(heldOut[6 + i]); sample.id = `h${i.toString(16).padStart(3, '0')}` + suffix; remaining -= take
  }
  expect(remaining).toBe(0); expect(Buffer.byteLength(JSON.stringify(survey))).toBe(258000)
  const text = JSON.stringify(request) + '\n'
  expect(Buffer.byteLength(text)).toBe(260167)
  expect(farmingSha(text)).toBe('c23c76b807da45a198bcaedc557b42a1023a2c4b943bdb323be9aa707cf811ed')
  return text
}
test('a fixed admissible request reaching the complete planning output ceiling is refused without truncation', async () => {
  await farmingRefusal(farmingOutputWitness(), RangeError, 'farming-plan-limit')
})

for (const absent of ['TextEncoder', 'structuredClone', 'crypto']) {
  test(`missing host ${absent} is unavailable in an isolated public-call child`, async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, dirname } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'farming-host-'))
    const api = new URL('../../resources/functions/drone/agriculture/farming-plan.ts', import.meta.url).href
    const input = new URL('../../examples/farming-plan.json', import.meta.url).href
    const script = `import { readFileSync } from 'node:fs';
      const { planFarmingObservation } = await import(${JSON.stringify(api)});
      const text = readFileSync(new URL(${JSON.stringify(input)}), 'utf8');
      Object.defineProperty(globalThis, ${JSON.stringify(absent)}, { value: undefined, configurable: true });
      try { await planFarmingObservation(text); process.exitCode = 2; }
      catch (error) { process.stdout.write(JSON.stringify({ name: error instanceof Error ? error.name : null, message: error instanceof Error ? error.message : null }) + '\\n'); }`
    try {
      const result = spawnSync(process.execPath, ['--no-install', '--eval', script], { cwd: directory, env: { HOME: directory, PATH: dirname(process.execPath), BUN_CONFIG_NO_INSTALL: '1' }, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4096 })
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe('{"name":"Error","message":"farming-plan-unavailable"}\n')
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }, 65000)
}
