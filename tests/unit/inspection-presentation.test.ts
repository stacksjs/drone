import { expect, test } from 'bun:test'
import { inspectionImagePreview } from '../../resources/functions/drone/inspection/presentation'

test('inspection previews preserve actual visible pixels and a fixed synthetic thermal scale with nodata', () => {
  const capture = { image: { width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), thermalCentiKelvin: new Uint16Array([29315, 0]) } }
  const visible = decodeURIComponent(inspectionImagePreview(capture, 'visible'))
  expect(visible).toContain('fill="#ff0000" d="M0 0h1v1H0z"')
  expect(visible).toContain('fill="#0000ff" d="M1 0h1v1H1z"')
  const thermal = decodeURIComponent(inspectionImagePreview(capture, 'thermal'))
  expect(thermal).toContain('fill="#0000ff" d="M0 0h1v1H0z"')
  expect(thermal).toContain('fill="#262626" d="M1 0h1v1H1z"')
  expect(() => inspectionImagePreview({ image: { ...capture.image, width: 0 } }, 'visible')).toThrow()
  expect(() => inspectionImagePreview({ image: { ...capture.image, thermalCentiKelvin: new Uint16Array(1) } }, 'thermal')).toThrow()
})
