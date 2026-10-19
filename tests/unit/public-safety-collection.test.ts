import { describe, expect, test } from 'bun:test'
import { examplePublicSafetyConfig } from '../../resources/functions/drone/public-safety/fixtures'
import { simulateSurvey } from '../../resources/functions/drone/mapping/runtime'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'
import { createPublicSafetyCamera, renderPublicSafetyImage } from '../../resources/functions/drone/public-safety/camera'
import { planPublicSafetyMission, publicSafetySessionId } from '../../resources/functions/drone/public-safety/planner'

describe('public-safety collection planning', () => {
  test('retains purpose, selected search sector, operating boundary and retention without granting physical authority', () => {
    const plan = planPublicSafetyMission(examplePublicSafetyConfig())
    expect(plan.config.purpose).toBe('search-and-rescue')
    expect(plan.searchAreaM2).toBeCloseTo(2.56, 10)
    expect(plan.survey.config.boundary).toEqual(plan.config.sectors[0]!.boundary)
    expect(plan.mission.tasks.length).toBeGreaterThan(3)
    expect(plan.config.retention.expiresAt).toBe('2027-01-01T00:00:00.000Z')
    expect(plan.assumptions.join(' ')).toContain('unqualified')
  })
})

describe('public-safety collection boundary', () => {
  test('rejects active caller objects before cloning or reading a getter', () => {
    const config = examplePublicSafetyConfig()
    let reads = 0
    Object.defineProperty(config.retention, 'expiresAt', { enumerable: true, get() { reads++; return '2027-01-01T00:00:00.000Z' } })
    expect(() => planPublicSafetyMission(config)).toThrow('accessor')
    expect(reads).toBe(0)
    const inherited = examplePublicSafetyConfig()
    Object.setPrototypeOf(inherited.survey.boundary, { [Symbol.iterator]() { reads++; return [][Symbol.iterator]() } })
    expect(() => planPublicSafetyMission(inherited)).toThrow('plain')
    expect(reads).toBe(0)
  })
  test('checks the interior of concave route connectors, not only lane endpoints', () => {
    const config = examplePublicSafetyConfig()
    config.operatingBoundary = [[-3, -3], [3, -3], [3, .05], [-.1, .05], [-.1, .25], [3, .25], [3, 3], [-3, 3]]
    // The selected sector crosses the notch despite every rectangle corner lying inside.
    expect(() => planPublicSafetyMission(config)).toThrow('out-of-boundary')
  })
  test('rejects invalid retention, missing selected sector and excessive imagery', () => {
    for (const expiry of ['2027-02-30T00:00:00.000Z', 'never', '2100-01-01T00:00:00.000Z']) {
      const config = examplePublicSafetyConfig(); config.retention.expiresAt = expiry
      expect(() => planPublicSafetyMission(config)).toThrow('retention')
    }
    const missing = examplePublicSafetyConfig(); missing.sectorId = 'not-present'
    expect(() => planPublicSafetyMission(missing)).toThrow('selected')
    const huge = examplePublicSafetyConfig(); huge.survey.calibration.output.width = 1000; huge.survey.calibration.output.height = 1000
    expect(() => planPublicSafetyMission(huge)).toThrow()
  })
  test('supports every explicit incident purpose without changing vehicle control or granting a role', () => {
    for (const purpose of ['search-and-rescue', 'fire-observation', 'disaster-assessment', 'lawful-police-observation'] as const) {
      const plan = planPublicSafetyMission(examplePublicSafetyConfig(purpose))
      expect(plan.config.purpose).toBe(purpose)
      expect(plan.mission.frame).toBe('LOCAL_NED')
    }
  })
})


describe('public-safety synthetic visible and numeric thermal shutter', () => {
  test('captures independent literal colours and temperatures from the nadir scene at exposure time', () => {
    const plan = planPublicSafetyMission(examplePublicSafetyConfig())
    const body = createRigidBody({ positionM: [.35, .15, -1.5] }).snapshot()
    const index = 35 * 96 + 47
    const image = renderPublicSafetyImage(plan, body)
    expect(Array.from(image.rgba.slice(index * 4, index * 4 + 4))).toEqual([220, 100, 40, 255])
    expect(image.thermalCentiKelvin[index]).toBe(31015)
    expect(image.support[index]).toBe(1)
    const shutter = createPublicSafetyCamera(plan)
    shutter.camera.render(body, 1000)
    shutter.camera.request({ sessionId: 'incident:visit:revision', sequence: 1, issuedAtMs: 1000, reference: 'LOCAL_NED:0,0,100' })
    expect(shutter.thermalAcks()).toEqual([])
    shutter.camera.render(createRigidBody({ positionM: [-.7, -.7, -1.5] }).snapshot(), 1004)
    expect(shutter.camera.poll(1016)).toBeNull()
    const ack = shutter.camera.poll(1020)!
    expect(ack.capturedAtMs).toBe(1000)
    expect(Array.from(ack.rgba.slice(index * 4, index * 4 + 4))).toEqual([220, 100, 40, 255])
    expect(shutter.thermalAcks()[0]!.thermalCentiKelvin[index]).toBe(31015)
    const snapshot = shutter.thermalAcks(); snapshot[0]!.thermalCentiKelvin.fill(1)
    expect(shutter.thermalAcks()[0]!.thermalCentiKelvin[index]).toBe(31015)
    expect(Object.keys(shutter.thermalAcks()[0]!)).not.toContain('positionM')
    shutter.camera.close()
  })
})

test('rejects a transit that exits a concave operating boundary although the entire search sector is inside', () => {
  const config = examplePublicSafetyConfig()
  config.operatingBoundary = [[-2, -2], [2, -2], [2, -.2], [.1, -.2], [.1, .2], [2, .2], [2, 2], [-2, 2]]
  config.survey.boundary = [[.4, .4], [.8, .4], [.8, .8], [.4, .8]]
  config.sectors[0]!.boundary = structuredClone(config.survey.boundary)
  config.noObserveZones = []
  expect(() => planPublicSafetyMission(config)).toThrow('route segment')
})

test('masks the same ground truth ray in visible and numeric thermal before shutter retention', () => {
  const plan = planPublicSafetyMission(examplePublicSafetyConfig())
  const shutter = createPublicSafetyCamera(plan), index = 35 * 96 + 47
  // Mutating caller configuration after construction cannot remove the shutter privacy mask.
  plan.config.noObserveZones = []
  shutter.camera.render(createRigidBody({ positionM: [.55, .55, -1.5] }).snapshot(), 1000)
  shutter.camera.request({ sessionId: 'incident-1', sequence: 1, issuedAtMs: 1000, reference: 'LOCAL_NED:0,0,100' })
  const ack = shutter.camera.poll(1020)!, thermal = shutter.thermalAcks()[0]!
  expect(Array.from(ack.rgba.slice(index * 4, index * 4 + 4))).toEqual([0, 0, 0, 255])
  expect(thermal.thermalCentiKelvin[index]).toBe(0)
  expect(thermal.support[index]).toBe(2)
  expect(thermal.sessionId).toBe(ack.sessionId)
  expect(thermal.sequence).toBe(ack.sequence)
  expect(thermal.capturedAtMs).toBe(1000)
  expect(thermal.reference).toBe(ack.reference)
  shutter.camera.close()
})

test('preserves unobserved support and independent fire, disaster and blue visible-only values', () => {
  const index = 35 * 96 + 47
  const fire = renderPublicSafetyImage(planPublicSafetyMission(examplePublicSafetyConfig('fire-observation')), createRigidBody({ positionM: [.43, -.2, -1.5] }).snapshot())
  expect(Array.from(fire.rgba.slice(index * 4, index * 4 + 4))).toEqual([80, 65, 55, 255])
  expect(fire.thermalCentiKelvin[index]).toBe(38315)
  const disaster = renderPublicSafetyImage(planPublicSafetyMission(examplePublicSafetyConfig('disaster-assessment')), createRigidBody({ positionM: [.35, -.2, -1.5] }).snapshot())
  expect(Array.from(disaster.rgba.slice(index * 4, index * 4 + 4))).toEqual([145, 150, 155, 255])
  expect(disaster.thermalCentiKelvin[index]).toBe(29615)
  const blue = renderPublicSafetyImage(planPublicSafetyMission(examplePublicSafetyConfig()), createRigidBody({ positionM: [-.45, -.4, -1.5] }).snapshot())
  expect(Array.from(blue.rgba.slice(index * 4, index * 4 + 4))).toEqual([30, 80, 230, 255])
  expect(blue.thermalCentiKelvin[index]).toBe(29315)
  const outside = renderPublicSafetyImage(planPublicSafetyMission(examplePublicSafetyConfig()), createRigidBody({ positionM: [2, 2, -1.5] }).snapshot())
  expect(Array.from(outside.rgba.slice(index * 4, index * 4 + 4))).toEqual([0, 0, 0, 255])
  expect(outside.thermalCentiKelvin[index]).toBe(0)
  expect(outside.support[index]).toBe(0)
})

test('keeps lost and wrong ACK scope visible and cancels pending frames without inventing a capture', () => {
  const plan = planPublicSafetyMission(examplePublicSafetyConfig()), body = createRigidBody({ positionM: [0, 0, -1.5] }).snapshot()
  const lost = createPublicSafetyCamera(plan, 'loss')
  lost.camera.render(body, 12000); lost.camera.request({ sessionId: 'incident-1', sequence: 1, issuedAtMs: 12000, reference: 'LOCAL_NED:0,0,100' })
  expect(lost.camera.poll(12080)).toBeNull()
  expect(lost.thermalAcks()).toEqual([])
  lost.camera.close()
  expect(lost.camera.poll(14000)).toBeNull()
  expect(lost.thermalAcks()).toEqual([])
  const wrong = createPublicSafetyCamera(plan, 'wrong-ack')
  wrong.camera.render(body, 12000); wrong.camera.request({ sessionId: 'incident-2', sequence: 1, issuedAtMs: 12000, reference: 'LOCAL_NED:0,0,100' })
  const ack = wrong.camera.poll(12020)!
  expect(ack.reference).toBe('wrong-reference')
  expect(wrong.thermalAcks()[0]!.reference).toBe('wrong-reference')
  wrong.camera.close()
})

test('uses the calibrated nadir RDF-to-FRD orientation for off-axis rays', () => {
  const plan = planPublicSafetyMission(examplePublicSafetyConfig('fire-observation'))
  const image = renderPublicSafetyImage(plan, createRigidBody({ positionM: [.43, 0, -1.5] }).snapshot())
  // Image-right rays point west (negative east) under the independently supplied nadir calibration.
  // At 1.46 m optical depth, x=56.5 intersects east about -0.207 m inside the hot core.
  expect(image.thermalCentiKelvin[35 * 96 + 56]).toBe(38315)
  expect(image.thermalCentiKelvin[35 * 96 + 39]).toBe(29315)
})


test('collects the paired numeric instrument through the actual owned survey camera adapter', () => {
  const plan = planPublicSafetyMission(examplePublicSafetyConfig()), camera = createPublicSafetyCamera(plan)
  const run = simulateSurvey({ config: plan.config.survey, seconds: 100, cameraFactory: () => camera.camera })
  expect(run.status).toBe('completed')
  expect(run.captures.length).toBeGreaterThan(0)
  expect(run.boardNeutral).toBe(true)
  const acks = camera.thermalAcks()
  expect(acks.length).toBe(run.captures.length)
  for (const capture of run.captures) {
    const ack = acks.find(item => item.sessionId === capture.sessionId && item.sequence === capture.sequence && item.capturedAtMs === capture.capturedAtMs)!
    expect(ack.reference).toBe(capture.pose.reference)
    expect(ack.issuedAtMs).toBe(capture.issuedAtMs)
    expect(ack.acknowledgedAtMs).toBe(capture.acknowledgedAtMs)
    expect(ack.thermalCentiKelvin.length).toBe(capture.width * capture.height)
    let leaked = 0
    for (let i = 0; i < ack.support.length; i++) if (ack.support[i] !== 1 && (ack.thermalCentiKelvin[i] !== 0 || capture.rgba[i * 4] !== 0 || capture.rgba[i * 4 + 1] !== 0 || capture.rgba[i * 4 + 2] !== 0 || capture.rgba[i * 4 + 3] !== 255)) leaked++
    expect(leaked).toBe(0)
  }
})


test('binds an unambiguous bounded incident revision and visit session before execution', () => {
  expect(publicSafetySessionId({ id: 'a-b', revision: 'c', visitId: 'd' })).toBe('incident-3-a-b-1-c-1-d')
  expect(publicSafetySessionId({ id: 'a', revision: 'b-c', visitId: 'd' })).toBe('incident-1-a-3-b-c-1-d')
  const long = examplePublicSafetyConfig(); long.revision = 'r'.repeat(50)
  expect(() => planPublicSafetyMission(long)).toThrow('session scope')
  expect(() => publicSafetySessionId({ id: 'a', revision: 'b', visitId: 'x'.repeat(64) })).toThrow('session scope')
  expect(publicSafetySessionId(examplePublicSafetyConfig()).length).toBeLessThanOrEqual(64)
})
