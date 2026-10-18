import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'

test('native vision commands validate independent calibration and run the owned paired follow pipeline', async () => {
  const validation = await command(['vision:validate', 'examples/vision-calibration.json']).withTimeout(60000)
  expect(validation.exitCode).toBe(0)
  const report = JSON.parse(validation.stdout)
  expect(report.evidence).toBe('synthetic')
  expect(report.physicalCalibrationVerified).toBe(false)
  expect(report.maxErrorM).toBeLessThan(0.001)
  const nominal = await command(['vision:simulate', '--scenario', 'follow']).withTimeout(60000)
  expect(nominal.exitCode).toBe(0)
  const result = JSON.parse(nominal.stdout)
  expect(result.status).toBe('completed')
  expect(result.evidence).toBe('owned-vision-physics-simulation')
  expect(result.physicalFlightEnabled).toBe(false)
  expect(result.metrics.followTravelM).toBeGreaterThan(1)
  const lost = await command(['vision:simulate', '--scenario', 'depth-loss']).withTimeout(60000)
  expect(lost.exitCode).toBe(0)
  expect(JSON.parse(lost.stdout).status).toBe('blocked')
  for (const args of [['--scenario', 'physical'], ['--seconds', 'nan'], ['--seconds', '8.5']])
    expect((await command(['vision:simulate', ...args]).withTimeout(60000)).exitCode).toBe(1)
}, 180000)
