import { describe, expect, test } from 'bun:test'
import { simulatePublicSafety } from '../../resources/functions/drone/public-safety/runtime'
import { examplePublicSafetyConfig } from '../../resources/functions/drone/public-safety/fixtures'
import { publicSafetyRecordingData, publicSafetyRecordingJson, parsePublicSafetyRecording, validatePublicSafetyRun } from '../../resources/functions/drone/public-safety/evidence'

// Public function seam: actual owned sensor/physics/shutter decisions and retained bytes, not hardware radiometry or multiuser authorization.
describe('owned public-safety collection', () => {
  test('confirmed numeric evidence is scoped to the actual session and emitted before the producer returns', () => {
    let returned = false, events = 0, lastCount = 0
    const run = simulatePublicSafety({ onEvent(event) {
      expect(returned).toBe(false)
      expect(event.sequence).toBe(++events)
      expect(event.captureCount).toBeGreaterThanOrEqual(lastCount)
      lastCount = event.captureCount
      event.incidentRevision = 'consumer-mutation'
    } })
    returned = true
    expect(run.survey.status).toBe('completed')
    expect(run.survey.boardNeutral).toBe(true)
    expect(run.captures.length).toBeGreaterThan(0)
    expect(run.events.at(-1)!.captureCount).toBe(run.captures.length)
    expect(run.events.some(event => event.incidentRevision === 'consumer-mutation')).toBe(false)
    expect(run.captures.every(capture => capture.sessionId === run.sessionId)).toBe(true)
    expect(run.captures.every(capture => capture.thermalCentiKelvin.length === capture.width * capture.height && capture.support.some(n => n === 1))).toBe(true)
    expect(run.identityAuthenticated).toBe(false)
    const recording = publicSafetyRecordingJson(run)
    expect(parsePublicSafetyRecording(recording).survey.captures.length).toBe(run.captures.length)
    const changed = JSON.parse(recording)
    changed.captures[0].thermalCentiKelvin[0]++
    expect(() => validatePublicSafetyRun(changed)).toThrow('replay')
    changed.captures[0].thermalCentiKelvin[0]--
    changed.epochs[1].link.connected = false
    expect(() => validatePublicSafetyRun(changed)).toThrow('replay')
  }, 60000)

  test('actual runtime observations stop collection after link, resource and incident revision changes', () => {
    for (const scenario of ['link-loss', 'link-stale', 'battery-loss', 'boundary-change', 'endurance-change'] as const) {
      const run = simulatePublicSafety({ scenario })
      expect(run.captures.length).toBeGreaterThan(0)
      expect(run.faultDemonstrated).toBe(true)
      expect(['blocked', 'aborted']).toContain(run.survey.status)
      expect(run.survey.boardNeutral).toBe(true)
      expect(run.epochs.at(-1)!.decision).toBe('stop')
      expect(run.survey.trace.rows.at(-1)!.result.targetM).toBeNull()
      if (scenario === 'link-loss') expect(run.epochs.at(-1)!.link.connected).toBe(false)
      if (scenario === 'battery-loss') expect(run.survey.trace.rows.at(-1)!.observation.batteryPercent).toBe(20)
      if (scenario === 'boundary-change' || scenario === 'endurance-change') {
        expect(run.updates[0]!.requiresNewPilotAcceptance).toBe(true)
        expect(run.survey.trace.plan).toEqual(run.plan.mission)
        expect(run.epochs.at(-1)!.incidentRevision).toBe(run.updates[0]!.revision)
        expect(run.events.find(event => event.kind === 'incident-update')!.incidentRevision).toBe(run.updates[0]!.revision)
        expect(run.plan.config.revision).toBe(run.updates[0]!.previousRevision)
        if (scenario === 'endurance-change') expect(run.epochs.at(-1)!.reason).toBe('incident-endurance-requires-new-pilot-acceptance')
        expect(run.updates[0]!.operatingBoundary).toEqual(scenario === 'boundary-change' ? [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]] : null)
        expect(run.updates[0]!.remainingFlightMs).toBe(scenario === 'endurance-change' ? 0 : null)
      }
    }
  }, 60000)

  test('declared position loss follows confirmed imagery and replays actual sensor loss with neutral outputs', () => {
    const run = simulatePublicSafety({ scenario: 'position-loss' })
    expect(run.faultAtMs).toBe(12000)
    expect(run.captures.length).toBeGreaterThan(0)
    expect(run.faultDemonstrated).toBe(true)
    expect(run.survey.status).toBe('blocked')
    expect(run.survey.boardNeutral).toBe(true)
    expect(run.survey.captures.every(capture => capture.acknowledgedAtMs < 12000)).toBe(true)
    expect(run.survey.trace.rows.at(-1)!.observation.nowMs).toBeGreaterThanOrEqual(12000)
    expect(run.survey.trace.rows.at(-1)!.observation.healthy).toBe(false)
    expect(parsePublicSafetyRecording(publicSafetyRecordingJson(run)).faultDemonstrated).toBe(true)
    const slow = examplePublicSafetyConfig()
    slow.survey.altitudeAglM = 3
    const premature = simulatePublicSafety({ config: slow, scenario: 'position-loss', seconds: 8 })
    expect(premature.faultDemonstrated).toBe(false)
  }, 60000)

  test('source callback failure revokes outputs and cannot publish a replayable result', () => {
    expect(() => simulatePublicSafety({ onEvent() { throw new Error('consumer down') } })).toThrow('outputs were revoked')
    expect(() => simulatePublicSafety({ onEvent: (() => Promise.resolve()) as () => void })).toThrow('outputs were revoked')
  })

  test('short runs cannot claim a demonstrated loss; purposes remain observation-only', () => {
    const slow = examplePublicSafetyConfig()
    slow.survey.altitudeAglM = 3
    const short = simulatePublicSafety({ config: slow, scenario: 'link-loss', seconds: 8 })
    expect(short.faultDemonstrated).toBe(false)
    for (const purpose of ['search-and-rescue', 'fire-observation', 'disaster-assessment', 'lawful-police-observation'] as const) {
      const run = simulatePublicSafety({ config: examplePublicSafetyConfig(purpose), seconds: 8 })
      expect(run.plan.config.purpose).toBe(purpose)
      expect(run.physicalFlightEnabled).toBe(false)
      expect(run.physicalThermalVerified).toBe(false)
    }
  }, 60000)

  test('recording boundaries reject hooks, shared memory and hidden data before execution', () => {
    expect(publicSafetyRecordingData({ text: 'é中🙂', numbers: [-1, 2.5, 1e21], truth: true, empty: null })).toBe('{"empty":null,"numbers":[-1,2.5,1e+21],"text":"é中🙂","truth":true}')
    let called = 0
    const v = { get version() { called++; return 1 } }
    expect(() => publicSafetyRecordingData(v)).toThrow('accessor')
    const array = [1]
    Object.setPrototypeOf(array, { [Symbol.iterator]() { called++; return [][Symbol.iterator]() } })
    expect(() => publicSafetyRecordingData(array)).toThrow('prototype')
    expect(() => publicSafetyRecordingData(new Uint8Array(new SharedArrayBuffer(4)))).toThrow('shared')
    const disguised = new SharedArrayBuffer(4)
    Object.setPrototypeOf(disguised, ArrayBuffer.prototype)
    Object.defineProperty(disguised, 'byteLength', { get() { called++; return 4 } })
    expect(() => publicSafetyRecordingData(new Uint8Array(disguised))).toThrow('shared')
    expect(() => publicSafetyRecordingData(new Uint16Array(disguised))).toThrow('shared')
    expect(() => validatePublicSafetyRun({ image: new Uint8Array(disguised) })).toThrow('shared')
    expect(() => publicSafetyRecordingData(Object.defineProperty({}, 'toJSON', { value() { called++ } }))).toThrow('hidden')
    expect(called).toBe(0)
  })

  test('explicit null configuration cannot start a default incident collection', () => {
    let emitted = 0
    expect(() => simulatePublicSafety({ config: null, onEvent() { emitted++ } })).toThrow()
    expect(emitted).toBe(0)
  })

  test('boundary revisions retain the proposed shrunken geometry without editing the accepted graph', () => {
    const config = examplePublicSafetyConfig()
    config.operatingBoundary = [[-4, -2], [2, -2], [2, 4], [-4, 4]]
    const original = structuredClone(config.operatingBoundary)
    const run = simulatePublicSafety({ config, scenario: 'boundary-change' })
    expect(run.updates[0]!.operatingBoundary).toEqual([[-2.5, -.5], [.5, -.5], [.5, 2.5], [-2.5, 2.5]])
    expect(run.plan.config.operatingBoundary).toEqual(original)
    expect(config.operatingBoundary).toEqual(original)
    expect(run.survey.trace.plan).toEqual(run.plan.mission)
    expect(run.updates[0]!.atMs).toBe(run.faultAtMs!)
    expect(run.updates[0]!.requiresNewPilotAcceptance).toBe(true)
    const changed = JSON.parse(publicSafetyRecordingData(run))
    changed.updates[0].operatingBoundary[0][0] = -2.4
    expect(() => validatePublicSafetyRun(changed)).toThrow('replay')
  }, 60000)
})
