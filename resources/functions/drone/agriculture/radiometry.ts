import type { AgricultureBandCalibration, AgricultureCalibratedImage, AgricultureImage, AgricultureRadiometry } from './types'

function fail(reason: string): never { throw new RangeError(`Invalid agriculture radiometry: ${reason}`) }
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('expected plain record')
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key) || !names.includes(key) || ++count > names.length) fail('unsupported fields')
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail('accessors are unsupported')
  }
  if (count !== names.length) fail('missing fields')
}
function number(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(name)
}
function tuple(value: unknown, length: number, min: number, max: number, name: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== length) fail(name)
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key) || key !== String(count++) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(name)
    number(value[Number(key)], min, max, name)
  }
  if (count !== length) fail(name)
}
function band(input: unknown): asserts input is AgricultureBandCalibration {
  fields(input, ['name', 'wavelengthNm', 'bandwidthNm', 'width', 'height', 'bitDepth', 'blackLevelDn', 'coefficients', 'vignetteCenterPx', 'vignettePolynomial'])
  const b = input as unknown as AgricultureBandCalibration
  if (b.name !== 'red' && b.name !== 'nir' || b.bitDepth !== 16) fail('band identity and bit depth')
  number(b.wavelengthNm, b.name === 'red' ? 600 : 750, b.name === 'red' ? 700 : 1000, 'band wavelength')
  number(b.bandwidthNm, 1, 100, 'bandwidth')
  number(b.width, 1, 8192, 'raw grid width'); number(b.height, 1, 8192, 'raw grid height')
  if (!Number.isInteger(b.width) || !Number.isInteger(b.height)) fail('integer raw grid dimensions')
  number(b.blackLevelDn, 0, 65534, 'black level')
  tuple(b.coefficients, 3, -1, 1, 'radiometric coefficients'); number(b.coefficients[0], Number.MIN_VALUE, 1, 'radiometric scale')
  tuple(b.vignetteCenterPx, 2, 0, 8192, 'vignette center')
  if (b.vignetteCenterPx[0] > b.width || b.vignetteCenterPx[1] > b.height) fail('vignette center outside raw grid')
  tuple(b.vignettePolynomial, 6, -1, 1, 'vignette polynomial')
}
function exposure(timeUs: unknown, gain: unknown) {
  number(timeUs, 1, 1000000, 'exposure'); number(gain, .01, 256, 'gain')
}
function radiance(b: AgricultureBandCalibration, dn: number, pixel: [number, number], timeUs: number, gain: number): number {
  const r = Math.hypot(pixel[0] - b.vignetteCenterPx[0], pixel[1] - b.vignetteCenterPx[1])
  let polynomial = 0
  for (let i = b.vignettePolynomial.length - 1; i >= 0; i--) polynomial = (polynomial + b.vignettePolynomial[i]!) * r
  polynomial += 1
  const seconds = timeUs / 1e6, [a1, a2, a3] = b.coefficients
  const row = 1 + a2 * pixel[1] / seconds - a3 * pixel[1]
  if (!(polynomial > 1e-12) || !(row > 1e-12)) fail('nonpositive row or vignette denominator')
  const result = Math.max(0, dn - b.blackLevelDn) / polynomial / row / (gain * seconds) * a1 / 65536
  if (!Number.isFinite(result) || result < 0) fail('nonfinite radiance')
  return result
}
/** MicaSense-v1 scalar spectral radiance, W/m2/sr/nm. Coordinates remain on the original raw DN grid. */
export function agricultureRadiance(calibration: AgricultureBandCalibration, dn: number, pixel: [number, number], exposureTimeUs: number, gain: number): number {
  band(calibration); exposure(exposureTimeUs, gain)
  tuple(pixel, 2, 0, 8192, 'raw pixel')
  if (!pixel.every(Number.isInteger) || pixel[0] >= calibration.width || pixel[1] >= calibration.height) fail('raw pixel outside grid')
  number(dn, 0, 65534, 'unsaturated DN'); if (!Number.isInteger(dn)) fail('integer DN')
  return radiance(calibration, dn, pixel, exposureTimeUs, gain)
}

function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('identifier')
}
function array(value: unknown, minimum: number, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail('array resource bound')
  let count = 0
  for (const key in value) if (!Object.hasOwn(value, key) || key !== String(count++) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail('sparse, extended or accessor array')
  if (count !== value.length) fail('sparse array')
}
function dimensions(width: unknown, height: unknown): asserts width is number {
  number(width, 1, 8192, 'width'); number(height, 1, 8192, 'height')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 65536) fail('image pixel budget')
}
/** Strict, bounded detached profile. Panel samples preserve original DN coordinates and illumination. */
export function validateAgricultureRadiometry(input: unknown, width: number, height: number): AgricultureRadiometry {
  dimensions(width, height)
  fields(input, ['id', 'model', 'evidence', 'bands', 'panels', 'maxPanelAgeMs', 'maxIrradianceAgeMs', 'maxSyncMs', 'maxRegistrationErrorPx', 'relativeRadianceUncertainty', 'relativeIrradianceUncertainty'])
  const c = input as unknown as AgricultureRadiometry
  identifier(c.id)
  if (c.model !== 'micasense-v1' || !['synthetic', 'declared-bench'].includes(c.evidence)) fail('model or evidence')
  number(c.maxPanelAgeMs, 1, 86400000, 'panel age bound'); number(c.maxIrradianceAgeMs, 1, 2000, 'irradiance age bound')
  number(c.maxSyncMs, 0, 100, 'synchronization bound'); number(c.maxRegistrationErrorPx, 0, 2, 'registration bound')
  number(c.relativeRadianceUncertainty, 0, .5, 'radiance uncertainty'); number(c.relativeIrradianceUncertainty, 0, .5, 'irradiance uncertainty')
  array(c.bands, 2, 2)
  for (const [index, b] of c.bands.entries()) {
    band(b)
    if (b.name !== (index === 0 ? 'red' : 'nir') || b.width !== width || b.height !== height) fail('ordered band grids must match image')
  }
  if (c.bands[0].wavelengthNm + c.bands[0].bandwidthNm / 2 >= c.bands[1].wavelengthNm - c.bands[1].bandwidthNm / 2) fail('spectral bands overlap')
  array(c.panels, 2, 16)
  const ids = new Set<string>(), epochs = new Set<string>(), counts = { red: 0, nir: 0 }
  for (const p of c.panels) {
    fields(p, ['id', 'band', 'certificateId', 'capturedAtMs', 'exposureTimeUs', 'gain', 'reflectance', 'reflectanceUncertainty', 'irradianceWm2Nm', 'samples'])
    identifier(p.id); identifier(p.certificateId)
    if (p.band !== 'red' && p.band !== 'nir') fail('panel band')
    number(p.capturedAtMs, 0, Number.MAX_SAFE_INTEGER, 'panel epoch')
    if (!Number.isSafeInteger(p.capturedAtMs) || ids.has(p.id) || epochs.has(`${p.band}:${p.capturedAtMs}`) || ++counts[p.band] > 8) fail('ambiguous panel identity, epoch or count')
    ids.add(p.id); epochs.add(`${p.band}:${p.capturedAtMs}`)
    exposure(p.exposureTimeUs, p.gain)
    number(p.reflectance, Number.MIN_VALUE, 1, 'panel reflectance'); number(p.reflectanceUncertainty, 0, 1, 'panel reflectance uncertainty')
    if (p.reflectance - p.reflectanceUncertainty <= 0 || p.reflectance + p.reflectanceUncertainty > 1) fail('panel reflectance interval')
    number(p.irradianceWm2Nm, 1e-9, 100000, 'panel irradiance')
    array(p.samples, 1, 64)
    const b = c.bands[p.band === 'red' ? 0 : 1], pixels = new Set<string>()
    for (const sample of p.samples) {
      fields(sample, ['pixel', 'dn'])
      tuple(sample.pixel, 2, 0, 8192, 'panel pixel')
      if (!sample.pixel.every(Number.isInteger) || sample.pixel[0] >= width || sample.pixel[1] >= height || pixels.has(sample.pixel.join(','))) fail('panel pixel outside grid or duplicated')
      pixels.add(sample.pixel.join(','))
      number(sample.dn, 0, 65534, 'unsaturated panel DN')
      if (!Number.isInteger(sample.dn) || sample.dn <= b.blackLevelDn + .5) fail('panel signal does not exceed black and quantization')
      const l = radiance(b, sample.dn, sample.pixel, p.exposureTimeUs, p.gain)
      if (!(l > 0)) fail('nonpositive panel radiance')
    }
  }
  if (!counts.red || !counts.nir) fail('both bands require a panel')
  return structuredClone(c)
}
function epoch(value: unknown) { number(value, 0, Number.MAX_SAFE_INTEGER, 'capture epoch'); if (!Number.isSafeInteger(value)) fail('integer capture epoch') }
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
function raster(value: unknown, length: number, kind: 'rgba' | 'counts') {
  if (!(kind === 'rgba' ? value instanceof Uint8Array : value instanceof Uint16Array)) fail('typed raster dimensions')
  for (const key of ['length', 'buffer', 'byteLength', 'byteOffset']) if (Object.getOwnPropertyDescriptor(value, key)) fail('shadowed raster accessors are unsupported')
  if (typedLength.call(value) !== length) fail('typed raster dimensions')
  if (typeof SharedArrayBuffer !== 'undefined' && typedBuffer.call(value) instanceof SharedArrayBuffer) fail('shared raster memory is unsupported')
}
function pixelScale(b: AgricultureBandCalibration, pixel: [number, number], timeUs: number, gain: number) {
  return radiance(b, b.blackLevelDn + 1, pixel, timeUs, gain)
}
/** Registered, synchronized band processing. Invalid pixels stay masked; metadata faults reject the entire frame. */
export function calibrateAgricultureImage(calibration: AgricultureRadiometry, input: AgricultureImage, capturedAtMs: number): AgricultureCalibratedImage {
  fields(input, ['width', 'height', 'rgba', 'registrationId', 'registrationErrorPx', 'bands'])
  dimensions(input.width, input.height); epoch(capturedAtMs)
  const c = validateAgricultureRadiometry(calibration, input.width, input.height), size = input.width * input.height
  identifier(input.registrationId); number(input.registrationErrorPx, 0, c.maxRegistrationErrorPx, 'registration error exceeds bound')
  raster(input.rgba, size * 4, 'rgba'); array(input.bands, 2, 2)
  for (const [index, frame] of input.bands.entries()) {
    fields(frame, ['band', 'capturedAtMs', 'exposureTimeUs', 'gain', 'irradiance', 'counts'])
    if (frame.band !== (index === 0 ? 'red' : 'nir')) fail('ordered frame band identity')
    epoch(frame.capturedAtMs); exposure(frame.exposureTimeUs, frame.gain)
    if (Math.abs(frame.capturedAtMs - capturedAtMs) > c.maxSyncMs) fail('band synchronization exceeded')
    fields(frame.irradiance, ['capturedAtMs', 'valueWm2Nm']); epoch(frame.irradiance.capturedAtMs)
    if (frame.irradiance.capturedAtMs > Math.min(frame.capturedAtMs, capturedAtMs) || Math.max(frame.capturedAtMs, capturedAtMs) - frame.irradiance.capturedAtMs > c.maxIrradianceAgeMs) fail('stale or future irradiance')
    number(frame.irradiance.valueWm2Nm, 1e-9, 100000, 'capture irradiance')
    raster(frame.counts, size, 'counts')
  }
  if (Math.abs(input.bands[0].capturedAtMs - input.bands[1].capturedAtMs) > c.maxSyncMs) fail('inter-band synchronization exceeded')
  const image = structuredClone(input)
  const profiles = image.bands.map((frame, index) => {
    const b = c.bands[index]!
    const panel = c.panels.filter(p => p.band === frame.band && p.capturedAtMs <= frame.capturedAtMs).sort((a, z) => z.capturedAtMs - a.capturedAtMs)[0]
    if (!panel || frame.capturedAtMs - panel.capturedAtMs > c.maxPanelAgeMs) fail('no fresh earlier panel calibration')
    let panelL = 0, panelQuantization = 0
    for (const sample of panel.samples) {
      panelL += radiance(b, sample.dn, sample.pixel, panel.exposureTimeUs, panel.gain) / panel.samples.length
      panelQuantization += .5 * pixelScale(b, sample.pixel, panel.exposureTimeUs, panel.gain) / panel.samples.length
    }
    const panelLow = panelL * (1 - c.relativeRadianceUncertainty) - panelQuantization
    const panelHigh = panelL * (1 + c.relativeRadianceUncertainty) + panelQuantization
    if (!(panelLow > 0)) fail('panel radiance uncertainty includes zero')
    const ratio = panel.reflectance / panelL * panel.irradianceWm2Nm / frame.irradiance.valueWm2Nm
    const lowerRatio = (panel.reflectance - panel.reflectanceUncertainty) / panelHigh * panel.irradianceWm2Nm * (1 - c.relativeIrradianceUncertainty) / (frame.irradiance.valueWm2Nm * (1 + c.relativeIrradianceUncertainty))
    const upperRatio = (panel.reflectance + panel.reflectanceUncertainty) / panelLow * panel.irradianceWm2Nm * (1 + c.relativeIrradianceUncertainty) / (frame.irradiance.valueWm2Nm * (1 - c.relativeIrradianceUncertainty))
    if (![ratio, lowerRatio, upperRatio].every(n => Number.isFinite(n) && n > 0)) fail('nonfinite panel correction')
    return { b, frame, ratio, lowerRatio, upperRatio }
  })
  const red = new Float64Array(size), nir = new Float64Array(size), ndvi = new Float64Array(size), lower = new Float64Array(size), upper = new Float64Array(size), valid = new Uint8Array(size)
  const invalidReasons: Record<string, number> = {}
  const invalid = (reason: string) => { invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1 }
  let validCount = 0
  for (let index = 0; index < size; index++) {
    const values: number[] = [], lows: number[] = [], highs: number[] = []
    const pixel: [number, number] = [index % image.width, Math.floor(index / image.width)]
    let rejected = false
    for (const { b, frame, ratio, lowerRatio, upperRatio } of profiles) {
      // Invalid calibration remains a whole-frame failure independently of
      // whether the sample's own DN will subsequently be masked.
      const quantization = .5 * pixelScale(b, pixel, frame.exposureTimeUs, frame.gain)
      const dn = frame.counts[index]!
      if (dn === 65535 || dn < b.blackLevelDn) { invalid(`${b.name}-${dn === 65535 ? 'saturated' : 'below-black'}`); rejected = true; continue }
      const l = radiance(b, dn, pixel, frame.exposureTimeUs, frame.gain), rho = l * ratio
      if (!Number.isFinite(rho) || rho < 0 || rho > 1) { invalid(`${b.name}-reflectance-out-of-range`); rejected = true; continue }
      values.push(rho)
      lows.push(Math.max(0, l * (1 - c.relativeRadianceUncertainty) - quantization) * lowerRatio)
      highs.push(Math.min(1, (l * (1 + c.relativeRadianceUncertainty) + quantization) * upperRatio))
    }
    if (rejected) continue
    const [r, n] = values as [number, number]
    if (r + n <= 1e-10) { invalid('near-zero-ndvi-denominator'); continue }
    red[index] = r; nir[index] = n; ndvi[index] = (n - r) / (n + r)
    const lowerSum = lows[1]! + highs[0]!, upperSum = highs[1]! + lows[0]!
    lower[index] = lowerSum > 1e-10 ? (lows[1]! - highs[0]!) / lowerSum : -1
    upper[index] = upperSum > 1e-10 ? (highs[1]! - lows[0]!) / upperSum : 1
    valid[index] = 1; validCount++
  }
  const validFraction = validCount / size
  return { width: image.width, height: image.height, red, nir, ndvi, lower, upper, valid, invalidReasons, qualified: validFraction >= .5, validFraction, uncertaintyEvidence: 'conditional-declared-input-bounds' }
}
