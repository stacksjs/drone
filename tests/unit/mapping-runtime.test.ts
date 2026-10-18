import { expect, test } from 'bun:test'
import { compileSurveyMission, simulateSurvey } from '../../resources/functions/drone/mapping/runtime'
import { exampleSurveyConfig } from '../../resources/functions/drone/mapping/fixtures'
import { createSurveyPlan } from '../../resources/functions/drone/mapping/planner'
import { replayMission } from '../../resources/functions/drone/missions/engine'

test('survey imagery comes from a completed owned mission with correlated capture poses and distinct pixels', () => {
  const plan = createSurveyPlan(exampleSurveyConfig())
  expect(compileSurveyMission(plan).tasks.length).toBeGreaterThan(4)
  const run = simulateSurvey()
  expect(run.status).toBe('completed')
  expect(run.captures.length).toBeGreaterThan(3)
  expect(run.boardNeutral).toBe(true)
  expect(replayMission(run.trace).snapshot().state).toBe('completed')
  expect(new Set(run.captures.map(frame => Array.from(frame.rgba).join(','))).size).toBeGreaterThan(3)
  for (const capture of run.captures) {
    expect(capture.pose.capturedAtMs).toBe(capture.capturedAtMs)
    expect(capture.acknowledgedAtMs).toBe(capture.capturedAtMs + 20)
    expect(capture.pose.headingAlignment).toBe('initial-simulation-north')
    expect(capture.rtk.status).toBe('unavailable')
    expect(capture.rgba.length).toBe(capture.width * capture.height * 4)
  }
  expect(run.physicalFlightEnabled).toBe(false)
})

import { renderSurveyImage } from '../../resources/functions/drone/mapping/camera'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'
test('independent ground landmarks occupy predicted nadir raster locations and move with the rendered camera', () => {
  const plan = createSurveyPlan(exampleSurveyConfig())
  const body = createRigidBody({ positionM: [0, 0, -1.5] }).snapshot()
  const raster = renderSurveyImage(plan, body)
  const pixel = (data: Uint8Array, x: number, y: number) => Array.from(data.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 4))
  expect(pixel(raster, 48, 36)).toEqual([240, 40, 30, 255])
  // At optical height1.46m, (N=.5,E=-.5) falls near pixel(68.5,56.5).
  expect(pixel(raster, 68, 56)).toEqual([30, 80, 240, 255])
  const moved = renderSurveyImage(plan, { ...body, positionM: [0.4, 0, -1.5] })
  expect(pixel(moved, 48, 19)).toEqual([240, 40, 30, 255])
  expect(pixel(moved, 48, 36)).not.toEqual([240, 40, 30, 255])
})

test('camera scope, missing ACK, pose loss and operator overrides cancel without accepting unqualified images', () => {
  for (const scenario of ['camera-loss', 'wrong-ack', 'imu-loss', 'position-loss', 'rc-override', 'abort'] as const) {
    const run = simulateSurvey({ scenario })
    expect(run.status).not.toBe('completed')
    expect(run.boardNeutral).toBe(true)
    expect(run.trace.rows.at(-1)!.result.targetM).toBeNull()
    expect(run.captures.every(capture => capture.acknowledgedAtMs <= run.trace.rows.at(-1)!.observation.nowMs)).toBe(true)
  }
})

test('crosshatch and declared terrain surveys execute both geometry and capture collection on the owned runtime', () => {
  for (const scenario of ['crosshatch', 'terrain'] as const) {
    const run = simulateSurvey({ scenario })
    expect(run.status).toBe('completed')
    expect(new Set(run.captures.map(capture => capture.laneId)).size).toBe(run.plan.lanes.length)
    expect(run.boardNeutral).toBe(true)
  }
  const partial = simulateSurvey({ seconds: 8 })
  expect(partial.status).toBe('incomplete')
  expect(partial.boardNeutral).toBe(true)
})

import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from 'ts-images'
test('native survey commands validate constraints, collect PNG imagery and reject premature or malformed evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-survey-cli-'))
  try {
    const planned = await command(['mapping:plan', '--config', 'examples/survey.json']).withTimeout(60000)
    expect(planned.exitCode).toBe(0)
    expect(JSON.parse(planned.stdout).lanes).toHaveLength(5)
    const collected = await command(['mapping:simulate', '--output', join(root, 'dataset')]).withTimeout(60000)
    expect(collected.exitCode).toBe(0)
    const summary = JSON.parse(collected.stdout)
    expect(summary.status).toBe('completed')
    expect(summary.quality.status).toBe('complete-collection')
    const manifest = JSON.parse(await readFile(summary.dataset.manifest, 'utf8'))
    expect(manifest.imageCount).toBe(summary.captures)
    expect(manifest.reconstructionPerformed).toBe(false)
    const image = await decode(await readFile(join(root, 'dataset', 'images', manifest.images[0].filename)))
    expect([image.width, image.height]).toEqual([96, 72])
    expect((await command(['mapping:simulate', '--scenario', 'camera-loss']).withTimeout(60000)).exitCode).toBe(0)
    for (const args of [['--seconds', 'nan'], ['--scenario', 'camera-loss', '--seconds', '8'], ['--scenario', 'unknown']]) {
      expect((await command(['mapping:simulate', ...args]).withTimeout(60000)).exitCode).toBe(1)
    }
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)
