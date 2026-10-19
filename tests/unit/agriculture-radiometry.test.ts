import { expect, test } from 'bun:test'
import type { AgricultureBandCalibration, AgricultureImage, AgricultureRadiometry } from '../../resources/functions/drone/agriculture/types'
import knownPanel from '../fixtures/agriculture/known-panel.json'
import { agricultureRadiance, validateAgricultureRadiometry, calibrateAgricultureImage } from '../../resources/functions/drone/agriculture/radiometry'

// Public numeric seam: independent pinned vendor-image values catch coefficient,
// normalization, row and vignette errors. They do not qualify a camera or field map.
test('actual vendor red/NIR DN samples reproduce independently evaluated calibrated radiance', () => {
  for (const band of knownPanel.bands) {
    const m = band.metadata
    const profile: AgricultureBandCalibration = {
      name: band.id as 'red' | 'nir', wavelengthNm: m.centerWavelengthNm, bandwidthNm: m.bandwidthNm,
      width: m.imageWidth, height: m.imageHeight, bitDepth: 16, blackLevelDn: m.blackLevel,
      coefficients: m.radiometricCalibration as [number, number, number],
      vignetteCenterPx: m.vignetteCenter as [number, number],
      vignettePolynomial: m.vignettePolynomial as AgricultureBandCalibration['vignettePolynomial'],
    }
    for (const roi of [band.panelRoi, band.validationRoi]) for (const [index, dn] of roi.rawDn.entries()) {
      expect(agricultureRadiance(profile, dn, [roi.x + index % 4, roi.y + Math.floor(index / 4)], m.exposureSeconds * 1e6, m.gain)).toBeCloseTo(roi.expectedRadiance[index]!, 12)
    }
  }
})

function profile(): AgricultureRadiometry {
  const base = { width: 4, height: 2, bitDepth: 16 as const, blackLevelDn: 4000, coefficients: [.001, 0, 0] as [number, number, number], vignetteCenterPx: [2, 1] as [number, number], vignettePolynomial: [0, 0, 0, 0, 0, 0] as AgricultureBandCalibration['vignettePolynomial'] }
  return {
    id: 'worked-panel', model: 'micasense-v1', evidence: 'synthetic',
    bands: [{ ...base, name: 'red', wavelengthNm: 668, bandwidthNm: 14 }, { ...base, name: 'nir', wavelengthNm: 842, bandwidthNm: 57 }],
    panels: (['red', 'nir'] as const).map(name => ({ id: `panel-${name}`, band: name, certificateId: 'declared-example', capturedAtMs: 0, exposureTimeUs: 1000, gain: 1, reflectance: .5, reflectanceUncertainty: .01, irradianceWm2Nm: 2, samples: [{ pixel: [0, 0], dn: 24000 }] })),
    maxPanelAgeMs: 2000, maxIrradianceAgeMs: 100, maxSyncMs: 10, maxRegistrationErrorPx: .5, relativeRadianceUncertainty: .01, relativeIrradianceUncertainty: .01,
  }
}
function image(): AgricultureImage {
  return { width: 4, height: 2, rgba: new Uint8Array(32).fill(255), registrationId: 'registered-example', registrationErrorPx: .1, bands: (['red', 'nir'] as const).map(name => ({ band: name, capturedAtMs: 1000, exposureTimeUs: 1000, gain: 1, irradiance: { capturedAtMs: 1000, valueWm2Nm: 2 }, counts: new Uint16Array(8).fill(name === 'red' ? 8000 : 32000) })) as AgricultureImage['bands'] }
}

test('registered raw bands use per-band panels and irradiance to recover a worked reflectance and NDVI', () => {
  const p = validateAgricultureRadiometry(profile(), 4, 2), raw = image()
  const result = calibrateAgricultureImage(p, raw, 1000)
  expect(result.qualified).toBe(true)
  expect(result.validFraction).toBe(1)
  expect([...result.valid]).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  for (let i = 0; i < 8; i++) {
    expect(result.red[i]).toBeCloseTo(.1, 12)
    expect(result.nir[i]).toBeCloseTo(.7, 12)
    expect(result.ndvi[i]).toBeCloseTo(.75, 12)
    expect(result.lower[i]).toBeLessThan(.75)
    expect(result.upper[i]).toBeGreaterThan(.75)
  }
  // Twice the capture illumination gives twice the signal above black, with
  // equal recovered reflectance. The red and NIR exposures need not match.
  raw.bands[0].counts.fill(12000); raw.bands[0].irradiance.valueWm2Nm = 4
  raw.bands[1].counts.fill(32000); raw.bands[1].exposureTimeUs = 2000; raw.bands[1].irradiance.valueWm2Nm = 1
  const adjusted = calibrateAgricultureImage(p, raw, 1000)
  expect(adjusted.red[0]).toBeCloseTo(.1, 12)
  expect(adjusted.nir[0]).toBeCloseTo(.7, 12)
  expect(adjusted.ndvi[0]).toBeCloseTo(.75, 12)
  p.panels[0]!.reflectance = .2
  expect(result.red[0]).toBeCloseTo(.1, 12)
})

test('invalid calibration denominators remain metadata failures even when every scene pixel is saturated', () => {
  const p = profile(), raw = image()
  // Panel samples are on y=0, while row y=1 has denominator 1-2=-1.
  p.bands[0].coefficients[1] = -.002
  raw.bands[0].counts.fill(65535); raw.bands[1].counts.fill(65535)
  expect(() => calibrateAgricultureImage(p, raw, 1000)).toThrow('denominator')
})

test('raster validation never invokes shadowed typed-array accessors', () => {
  const raw = image()
  Object.defineProperty(raw.bands[0].counts, 'length', { get() { throw new Error('PRIVATE_TYPED_ACCESSOR_INVOKED') } })
  expect(() => calibrateAgricultureImage(profile(), raw, 1000)).not.toThrow('PRIVATE_TYPED_ACCESSOR_INVOKED')
  expect(() => calibrateAgricultureImage(profile(), raw, 1000)).toThrow('shadowed raster')
})

test('masked pixels retain zero placeholders and explicit reasons rather than clamped indices', () => {
  const raw = image()
  raw.bands[0].counts[0] = 65535
  raw.bands[1].counts[1] = 3999
  raw.bands[0].counts[2] = 65000
  raw.bands[0].counts[3] = 4000; raw.bands[1].counts[3] = 4000
  const result = calibrateAgricultureImage(profile(), raw, 1000)
  expect([...result.valid]).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
  expect(result.qualified).toBe(true)
  expect(result.validFraction).toBe(.5)
  expect(result.invalidReasons).toEqual({ 'red-saturated': 1, 'nir-below-black': 1, 'red-reflectance-out-of-range': 1, 'near-zero-ndvi-denominator': 1 })
  for (const values of [result.red, result.nir, result.ndvi, result.lower, result.upper]) expect([...values.slice(0, 4)]).toEqual([0, 0, 0, 0])
  raw.bands[0].counts[4] = 65535
  expect(calibrateAgricultureImage(profile(), raw, 1000).qualified).toBe(false)
})

test('synchronization, irradiance, registration and calibration faults reject whole images', () => {
  const failures: ((p: AgricultureRadiometry, raw: AgricultureImage) => void)[] = [
    (_p, raw) => { raw.registrationErrorPx = .6 },
    (_p, raw) => { raw.registrationId = '' },
    (_p, raw) => { raw.bands[1].capturedAtMs = 1011 },
    (_p, raw) => { raw.bands[0].capturedAtMs = 990; raw.bands[0].irradiance.capturedAtMs = 990; raw.bands[1].capturedAtMs = 1010 },
    (_p, raw) => { raw.bands[0].irradiance.capturedAtMs = 899 },
    (_p, raw) => { raw.bands[0].irradiance.capturedAtMs = 1001 },
    (_p, raw) => { raw.bands[0].irradiance.valueWm2Nm = 0 },
    (_p, raw) => { raw.bands[0].exposureTimeUs = 0 },
    (_p, raw) => { raw.bands[1].gain = Number.NaN },
    (_p, raw) => { raw.bands.reverse() },
    (_p, raw) => { raw.bands[0].counts = new Uint16Array(1) },
    (_p, raw) => { raw.rgba = new Uint8Array(1) },
    (_p, raw) => { raw.bands[0].counts = new Uint16Array(new SharedArrayBuffer(16)) },
    (p) => { p.panels[0]!.capturedAtMs = 1001 },
    (p) => { p.maxPanelAgeMs = 999 },
    (p) => { p.bands[0].width = 5 },
    (p) => { p.panels[0]!.samples[0]!.dn = 65535 },
    (p) => { p.panels[0]!.samples[0]!.dn = 4000 },
    (p) => { p.panels[0]!.samples[0]!.pixel = [4, 0] },
    (p) => { p.panels[0]!.reflectanceUncertainty = .5 },
    (p) => { Object.defineProperty(p.panels[0]!, 'private', { enumerable: true, get() { throw new Error('PRIVATE_METADATA_ACCESSOR_INVOKED') } }) },
  ]
  for (const mutate of failures) {
    const p = profile(), raw = image(); mutate(p, raw)
    expect(() => calibrateAgricultureImage(p, raw, 1000)).toThrow()
  }
})

test('panel selection uses the freshest preceding band calibration and never a future observation', () => {
  const p = profile(), raw = image()
  p.panels.push({ ...structuredClone(p.panels[0]!), id: 'red-later', capturedAtMs: 500, reflectance: .25 })
  p.panels.push({ ...structuredClone(p.panels[0]!), id: 'red-future', capturedAtMs: 1001, reflectance: .9, reflectanceUncertainty: .01 })
  expect(calibrateAgricultureImage(p, raw, 1000).red[0]).toBeCloseTo(.05, 12)
  p.panels.reverse()
  expect(calibrateAgricultureImage(p, raw, 1000).red[0]).toBeCloseTo(.05, 12)
  p.panels.push({ ...structuredClone(p.panels.find(panel => panel.id === 'red-later')!), id: 'red-ambiguous' })
  expect(() => validateAgricultureRadiometry(p, 4, 2)).toThrow('ambiguous')
})

test('profiles detach bounded data, reject accessors before reading, and enforce complete band/panel identity', () => {
  const original = profile(), result = validateAgricultureRadiometry(original, 4, 2)
  original.panels[0]!.samples[0]!.dn = 10
  expect(result.panels[0]!.samples[0]!.dn).toBe(24000)
  const p = profile()
  Object.defineProperty(p, 'bands', { enumerable: true, get() { throw new Error('PRIVATE_METADATA_ACCESSOR_INVOKED') } })
  expect(() => validateAgricultureRadiometry(p, 4, 2)).toThrow('accessors are unsupported')
  for (const mutate of [
    (p: AgricultureRadiometry) => { p.bands[0].name = 'nir' },
    (p: AgricultureRadiometry) => { p.bands[0].wavelengthNm = 550 },
    (p: AgricultureRadiometry) => { p.panels.pop() },
    (p: AgricultureRadiometry) => { p.panels[0]!.samples = Array(65).fill({ pixel: [0, 0], dn: 24000 }) },
    (p: AgricultureRadiometry) => { p.panels[0]!.samples.push({ pixel: [0, 0], dn: 24000 }) },
    (p: AgricultureRadiometry) => { p.relativeIrradianceUncertainty = 1 },
  ]) { const p = profile(); mutate(p); expect(() => validateAgricultureRadiometry(p, 4, 2)).toThrow() }
  expect(() => validateAgricultureRadiometry(profile(), 8192, 8192)).toThrow('pixel budget')
})

test('conditional NDVI bounds retain quantization and widen with declared panel and irradiance uncertainty', () => {
  const tight = profile()
  tight.relativeIrradianceUncertainty = 0; tight.relativeRadianceUncertainty = 0
  for (const panel of tight.panels) panel.reflectanceUncertainty = 0
  const a = calibrateAgricultureImage(tight, image(), 1000), b = calibrateAgricultureImage(profile(), image(), 1000)
  expect(a.lower[0]).toBeLessThan(.75); expect(a.upper[0]).toBeGreaterThan(.75)
  expect(b.lower[0]).toBeLessThan(a.lower[0]!)
  expect(b.upper[0]).toBeGreaterThan(a.upper[0]!)
  expect(b.uncertaintyEvidence).toBe('conditional-declared-input-bounds')
})

test('vendor reference-panel ROI means reproduce independently retained reflectance and NDVI scalar values', () => {
  const means: number[] = []
  for (const band of knownPanel.bands) {
    const m = band.metadata
    const p: AgricultureBandCalibration = { name: band.id as 'red' | 'nir', wavelengthNm: m.centerWavelengthNm, bandwidthNm: m.bandwidthNm, width: m.imageWidth, height: m.imageHeight, bitDepth: 16, blackLevelDn: m.blackLevel, coefficients: m.radiometricCalibration as [number, number, number], vignetteCenterPx: m.vignetteCenter as [number, number], vignettePolynomial: m.vignettePolynomial as AgricultureBandCalibration['vignettePolynomial'] }
    const actualMean = (roi: typeof band.panelRoi | typeof band.validationRoi) => roi.rawDn.reduce((sum, dn, index) => sum + agricultureRadiance(p, dn, [roi.x + index % 4, roi.y + Math.floor(index / 4)], m.exposureSeconds * 1e6, m.gain), 0) / roi.rawDn.length
    const reflectanceMean = actualMean(band.validationRoi) * m.panelReflectanceFromMetadata / actualMean(band.panelRoi)
    expect(reflectanceMean).toBeCloseTo(band.validationRoi.expectedMeanPanelCorrectedReflectance, 12)
    means.push(reflectanceMean)
  }
  // Different ROIs of a uniform reference panel, not registered crop pixels.
  expect((means[1]! - means[0]!) / (means[1]! + means[0]!)).toBeCloseTo(knownPanel.expectedNdviOfRoiMeans.panelCorrected, 12)
  expect(knownPanel.vendorPublishedScalarReference.panelMeanRadiance * Math.PI / knownPanel.vendorPublishedScalarReference.declaredPanelReflectance).toBeCloseTo(1.1482, 3)
})
