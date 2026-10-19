import { expect, test } from 'bun:test'
import { simulateSurvey } from '../../resources/functions/drone/mapping/runtime'
import { createSurveyCamera } from '../../resources/functions/drone/mapping/camera'
import type { SurveyShutterCommand } from '../../resources/functions/drone/mapping/camera'
import { surveyQuality } from '../../resources/functions/drone/mapping/quality'

// Public runtime function seam: same-loop collection and supervisor evidence, no physical camera qualification.
test('explicit survey session is sent to the real shutter and callbacks see only confirmed current captures', () => {
  const requested: SurveyShutterCommand[] = [], captured: { id: string, atMs: number }[] = []
  let latestEpoch = -1, sawCapture = false
  const run = simulateSurvey({
    sessionId: 'incident-23-visit-2',
    cameraFactory(plan, fault) {
      const camera = createSurveyCamera(plan, fault)
      return { ...camera, request(command) { requested.push(structuredClone(command)); camera.request(command) } }
    },
    observation(nowMs) { return { link: { capturedAtMs: nowMs, connected: !sawCapture } } },
    observe(context) { latestEpoch = context.nowMs; context.battery.remainingPercent = 0; return undefined },
    onCapture(capture, context) {
      expect(context.nowMs).toBe(latestEpoch)
      expect(capture.acknowledgedAtMs).toBe(context.nowMs)
      expect(capture.capturedAtMs).toBeLessThan(context.nowMs)
      expect(context.authority).toBe('autonomous')
      expect(context.battery.remainingPercent).toBeGreaterThan(90)
      expect(Object.keys(context).sort()).toEqual(['authority', 'battery', 'estimate', 'link', 'mission', 'nowMs', 'sensors'])
      captured.push({ id: capture.id, atMs: context.nowMs })
      capture.rgba.fill(0); capture.pose.positionM[0] = 999; capture.sessionId = 'mutated'
      context.estimate.health.localPosition = false
      sawCapture = true
    },
  })
  expect(captured).toHaveLength(1)
  expect(requested).toHaveLength(1)
  expect(requested[0]!.sessionId).toBe('incident-23-visit-2')
  expect(run.captures[0]!.sessionId).toBe(requested[0]!.sessionId)
  expect(run.captures[0]!.rgba.some(value => value !== 0)).toBe(true)
  expect(run.captures[0]!.pose.positionM[0]).not.toBe(999)
  expect(run.status).toBe('blocked')
  expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(captured[0]!.atMs + 20)
  expect(run.boardNeutral).toBe(true)
  expect(surveyQuality(run).observed.images).toBe(1)
})

test('survey epoch policy and confirmed-capture exceptions cancel the actual mission without new imagery', () => {
  for (const hook of ['abort', 'observe-throw', 'capture-throw', 'invalid-policy'] as const) {
    let seen = 0, cutoff = 0
    const run = simulateSurvey({
      observe(context) {
        if (seen === 0) return undefined
        cutoff = context.nowMs
        if (hook === 'observe-throw') throw new Error('observer failure')
        return hook === 'invalid-policy' ? 'resume' as 'abort' : 'abort'
      },
      onCapture(capture, context) {
        expect(capture.acknowledgedAtMs).toBe(context.nowMs)
        seen++
        if (hook === 'capture-throw') { cutoff = context.nowMs; throw new Error('capture handler failure') }
      },
    })
    expect(seen).toBe(1)
    expect(run.captures).toHaveLength(1)
    expect(run.status).toBe('aborted')
    expect(run.boardNeutral).toBe(true)
    expect(run.trace.rows.at(-1)!.observation.nowMs).toBe(cutoff)
    expect(run.reason).toBe(hook === 'observe-throw' ? 'collection-policy-failed' : hook === 'capture-throw' ? 'capture-observer-failed' : hook === 'invalid-policy' ? 'collection-policy-invalid' : 'collection-policy-abort')
  }
})

test('survey rejects invalid session scope before constructing the camera', () => {
  let constructed = false
  for (const sessionId of ['', 'secret/other', 'a'.repeat(65), 'space scope', 'Uppercase', 'incident:visit', null]) {
    expect(() => simulateSurvey({ sessionId: sessionId as string, cameraFactory(plan, fault) { constructed = true; return createSurveyCamera(plan, fault) } })).toThrow('session')
  }
  expect(constructed).toBe(false)
})

test('asynchronous or malformed notification returns cannot silently continue an owned collection', () => {
  const asyncRun = simulateSurvey({ onCapture() { return Promise.reject(new Error('late capture failure')) } })
  expect(asyncRun.captures).toHaveLength(1)
  expect(asyncRun.status).toBe('aborted')
  expect(asyncRun.reason).toBe('capture-observer-failed')
  expect(asyncRun.boardNeutral).toBe(true)
  const malformed = simulateSurvey({ onCapture() { return false } })
  expect(malformed.status).toBe('aborted')
  expect(malformed.reason).toBe('capture-observer-invalid')
  expect(malformed.captures).toHaveLength(1)
})
