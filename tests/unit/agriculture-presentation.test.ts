import { expect, test } from 'bun:test'
import { agricultureImagePreview, agricultureLayerPreview } from '../../resources/functions/drone/agriculture/presentation'
import { simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'
import { calibrateAgricultureImage } from '../../resources/functions/drone/agriculture/radiometry'
import { processAgriculture } from '../../resources/functions/drone/agriculture/layer'

test('agriculture previews use actual retained visible bytes, fixed numeric index colours and grey uncovered support', () => {
  const run = simulateAgriculture({ seconds: 10 })
  const frame = run.captures[0]!
  const calibrated = calibrateAgricultureImage(run.plan.config.radiometry, frame.image, frame.capturedAtMs)
  const visible = decodeURIComponent(agricultureImagePreview(frame, calibrated, 'visible'))
  expect(visible).toContain('width="96" height="72"')
  const rgb = [...frame.image.rgba.slice(0, 3)].map(n => n.toString(16).padStart(2, '0')).join('')
  expect(visible).toContain(`fill="#${rgb}"`)
  const index = decodeURIComponent(agricultureImagePreview(frame, calibrated, 'ndvi'))
  expect(index).not.toBe(visible)
  const empty = processAgriculture(simulateAgriculture({ seconds: 8 }))
  expect(empty.observedAreaM2).toBe(0)
  expect(decodeURIComponent(agricultureLayerPreview(empty))).toContain('fill="#262626"')
  expect(() => agricultureLayerPreview({ ...empty, cells: [] })).toThrow()
})
