import type { AgricultureCapture, AgricultureRun, LivestockObservation, LivestockObservationInput } from './types'
import type { SensorVector } from '../sensors/types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'
import { nedToGeodetic } from '../estimation/frames'
import { validateSurveyDataset } from '../mapping/quality'
import { compileSurveyMission } from '../mapping/runtime'
import { volumeInsideRing } from '../volumes/geometry'
import { createAgriculturePlan } from './planner'
import { calibrateAgricultureImage } from './radiometry'

export const agricultureEvidenceLimits = Object.freeze({ captures: 64, pixels: 65536, rawBytes: 64 * 1024 * 1024, recordingBytes: 16 * 1024 * 1024, metadataBytes: 8 * 1024 * 1024, traceRows: 6001, observations: 64 })
function fail(message: string): never { throw new TypeError(`Invalid agriculture evidence: ${message}`) }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype }
function fields(v: unknown, expected: readonly string[]) {
  if (!record(v)) fail('expected record')
  let count = 0
  for (const key in v) if (!Object.hasOwn(v, key) || !expected.includes(key) || ++count > expected.length) fail('unsupported fields')
  if (count !== expected.length) fail('missing fields')
}
function identifier(v: unknown): v is string { return typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v) }
function text(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 1000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}
function quotedBytes(value: string) {
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) bytes += 2
    else if (c < 32) bytes += 6
    else if (c < 128) bytes++
    else if (c < 2048) bytes += 2
    else if (c >= 0xD800 && c <= 0xDBFF && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) { bytes += 4; i++ }
    else if (c >= 0xD800 && c <= 0xDFFF) bytes += 6
    else bytes += 3
  }
  return bytes
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const typedByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
/** Bound wire bytes, ordinary metadata and image storage before getters, copying or numeric-array materialization. */
function bounded(input: unknown) {
  let nodes = 0, wire = 0, metadata = 0, raw = 0
  const ancestors = new Set<object>()
  function add(n: number, raster: boolean) {
    wire += n
    if (!raster) metadata += n
    if (wire > agricultureEvidenceLimits.recordingBytes || metadata > agricultureEvidenceLimits.metadataBytes) fail('recording or metadata resource bound')
  }
  function visit(v: unknown, depth: number, raster = false): void {
    if (++nodes > 8 * 1024 * 1024 || depth > 32) fail('recording structure resource bound')
    if (v === null) add(4, raster)
    else if (typeof v === 'boolean') add(v ? 4 : 5, raster)
    else if (typeof v === 'number') { if (!Number.isFinite(v)) fail('non-finite number'); add(String(v).length, raster) }
    else if (typeof v === 'string') { if (v.length > 4096) fail('oversized text'); add(quotedBytes(v), raster) }
    else if (v instanceof Uint8Array || v instanceof Uint16Array) {
      for (const key of ['length', 'buffer', 'byteLength', 'byteOffset']) if (Object.getOwnPropertyDescriptor(v, key)) fail('shadowed raster accessors')
      const length = typedLength.call(v) as number
      if (typeof SharedArrayBuffer !== 'undefined' && typedBuffer.call(v) instanceof SharedArrayBuffer) fail('shared image memory')
      if (length > agricultureEvidenceLimits.pixels * (v instanceof Uint8Array ? 4 : 1)) fail('raster resource bound')
      raw += typedByteLength.call(v) as number
      if (raw > agricultureEvidenceLimits.rawBytes) fail('raw image resource bound')
      add(2, true)
      for (let i = 0; i < length; i++) add((i ? 1 : 0) + String(v[i]).length, true)
    }
    else if (Array.isArray(v) || record(v)) {
      if (ancestors.has(v)) fail('cyclic recording')
      const array = Array.isArray(v)
      if (array && v.length > agricultureEvidenceLimits.pixels * 4) fail('array resource bound')
      if (array && raster) { raw += v.length * 2; if (raw > agricultureEvidenceLimits.rawBytes) fail('raw image resource bound') }
      ancestors.add(v); add(2, raster)
      let count = 0
      for (const key in v) {
        if (!Object.hasOwn(v, key)) fail('inherited recording fields')
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!
        if (!('value' in descriptor)) fail('accessor recording fields')
        if (array && key !== String(count)) fail('sparse or extended numeric array')
        if (++count > 262144) fail('object resource bound')
        add((count > 1 ? 1 : 0) + (array ? 0 : quotedBytes(key) + 1), raster)
        visit(descriptor.value, depth + 1, raster || key === 'rgba' || key === 'counts')
      }
      if (array && count !== v.length) fail('sparse numeric array')
      ancestors.delete(v)
    }
    else fail('unsupported recording value')
  }
  visit(input, 0)
}
function samples(input: unknown, length: number, bits: 8 | 16): Uint8Array | Uint16Array {
  if (!(Array.isArray(input) || (bits === 8 ? input instanceof Uint8Array : input instanceof Uint16Array)) || (input as { length: number }).length !== length || length > agricultureEvidenceLimits.pixels * (bits === 8 ? 4 : 1)) fail('invalid image storage')
  const values = input as number[] | Uint8Array | Uint16Array
  for (let i = 0; i < length; i++) { const value = values[i]!; if (!Number.isInteger(value) || value < 0 || value > (bits === 8 ? 255 : 65535)) fail('invalid numeric image sample') }
  return bits === 8 ? new Uint8Array(values) : new Uint16Array(values)
}
function captureImage(capture: AgricultureCapture, width: number, height: number) {
  fields(capture.image, ['width', 'height', 'rgba', 'registrationId', 'registrationErrorPx', 'bands'])
  const image = capture.image
  if (image.width !== width || image.height !== height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16 || width * height > agricultureEvidenceLimits.pixels || !Array.isArray(image.bands) || image.bands.length !== 2) fail('image dimensions or bands')
  image.rgba = samples(image.rgba, width * height * 4, 8) as Uint8Array
  for (const band of image.bands) {
    fields(band, ['band', 'capturedAtMs', 'exposureTimeUs', 'gain', 'irradiance', 'counts'])
    fields(band.irradiance, ['capturedAtMs', 'valueWm2Nm'])
    band.counts = samples(band.counts, width * height, 16) as Uint16Array
  }
}
/** Declared recording consistency, including actual mission replay, never sensor-producer authentication or whole sensor replay. */
export function validateAgricultureRun(input: unknown): AgricultureRun {
  bounded(input)
  fields(input, ['version', 'evidence', 'physicalFlightEnabled', 'physicalCalibrationVerified', 'visitId', 'scenario', 'plan', 'survey', 'captures', 'status', 'reason'])
  const source = input as AgricultureRun
  if (source.version !== 1 || source.evidence !== 'owned-agriculture-physics-simulation' || source.physicalFlightEnabled !== false || source.physicalCalibrationVerified !== false || !identifier(source.visitId) || !['nominal', 'irradiance-loss', 'band-skew', 'saturation', 'camera-loss', 'wrong-ack', 'position-loss', 'rc-override', 'abort'].includes(source.scenario) || !text(source.reason) || !['completed', 'aborted', 'blocked', 'incomplete'].includes(source.status) || !record(source.plan) || !Array.isArray(source.captures) || source.captures.length > agricultureEvidenceLimits.captures || !record(source.survey) || !Array.isArray(source.survey.captures) || source.survey.captures.length !== source.captures.length || !Array.isArray(source.survey.trace?.rows) || source.survey.trace.rows.length > agricultureEvidenceLimits.traceRows) fail('unsupported run or resource bound')
  const plan = createAgriculturePlan(source.plan.config)
  if (!same(plan, source.plan) || !same(source.survey.plan, plan.survey) || !same(source.survey.mission, compileSurveyMission(plan.survey)) || source.status !== source.survey.status || plan.config.radiometry.evidence !== 'synthetic') fail('plan, status or synthetic radiometry mismatch')
  const run = structuredClone(source)
  for (const visible of run.survey.captures) visible.rgba = samples(visible.rgba, visible.width * visible.height * 4, 8) as Uint8Array
  validateSurveyDataset(run.survey)
  const seen = new Set<string>()
  for (let i = 0; i < run.captures.length; i++) {
    const capture = run.captures[i]!, visible = run.survey.captures[i]!
    fields(capture, ['captureId', 'sessionId', 'sequence', 'reference', 'issuedAtMs', 'capturedAtMs', 'acknowledgedAtMs', 'image'])
    if (!identifier(capture.captureId) || seen.has(capture.captureId) || capture.captureId !== visible.id || capture.sessionId !== visible.sessionId || capture.sequence !== visible.sequence || capture.reference !== visible.pose.reference || capture.issuedAtMs !== visible.issuedAtMs || capture.capturedAtMs !== visible.capturedAtMs || capture.acknowledgedAtMs !== visible.acknowledgedAtMs) fail('raw capture differs from acknowledged visible capture')
    captureImage(capture, visible.width, visible.height)
    if (capture.image.rgba.some((n, j) => n !== visible.rgba[j])) fail('raw and visible source image bytes differ')
    const calibrated = calibrateAgricultureImage(plan.config.radiometry, capture.image, capture.capturedAtMs)
    if (!calibrated.qualified) fail('raw capture is radiometrically unqualified')
    seen.add(capture.captureId)
  }
  return { ...run, plan }
}
export function agricultureRecordingJson(input: AgricultureRun): string {
  return JSON.stringify(validateAgricultureRun(input), (_key, value) => value instanceof Uint8Array || value instanceof Uint16Array ? Array.from(value) : value)
}
export function parseAgricultureRecording(text: string): AgricultureRun {
  if (typeof text !== 'string' || text.length > agricultureEvidenceLimits.recordingBytes) fail('recording exceeds 16 MiB')
  let bytes = 0
  for (const character of text) { const p = character.codePointAt(0)!; bytes += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4; if (bytes > agricultureEvidenceLimits.recordingBytes) fail('recording exceeds 16 MiB') }
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new TypeError('Invalid agriculture recording JSON') }
  return validateAgricultureRun(value)
}
function observationInput(input: unknown): LivestockObservationInput {
  bounded(input)
  fields(input, ['id', 'animalId', 'captureId', 'pixel', 'observerId', 'observedAt', 'note'])
  const v = input as LivestockObservationInput
  if (![v.id, v.animalId, v.captureId, v.observerId].every(identifier) || !Array.isArray(v.pixel) || v.pixel.length !== 2 || Array.prototype.some.call(v.pixel, (n: number) => !Number.isSafeInteger(n) || n < 0) || !text(v.note) || typeof v.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.observedAt) || !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString() !== v.observedAt) fail('invalid explicit animal observation')
  return structuredClone(v)
}
async function sourceDigest(run: AgricultureRun, capture: AgricultureCapture): Promise<string> {
  const visible = run.survey.captures.find(c => c.id === capture.captureId)!
  const visibleMetadata = Object.fromEntries(Object.entries(visible).filter(([key]) => key !== 'rgba'))
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, encoding: 'agriculture-metadata-newline-rgba-red-uint16le-nir-uint16le', visitId: run.visitId, config: run.plan.config, visible: visibleMetadata, raw: { ...capture, image: { ...capture.image, rgba: undefined, bands: capture.image.bands.map(band => Object.fromEntries(Object.entries(band).filter(([key]) => key !== 'counts'))) } } }))
  const image = capture.image, bytes = new Uint8Array(header.length + 1 + image.rgba.length + image.width * image.height * 4)
  bytes.set(header); bytes[header.length] = 10; bytes.set(image.rgba, header.length + 1)
  const view = new DataView(bytes.buffer)
  let offset = header.length + 1 + image.rgba.length
  for (const band of image.bands) for (const count of band.counts) { view.setUint16(offset, count, true); offset += 2 }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('')
}
async function observe(run: AgricultureRun, input: LivestockObservationInput): Promise<LivestockObservation> {
  const capture = run.captures.find(c => c.captureId === input.captureId), visible = run.survey.captures.find(c => c.id === input.captureId)
  if (!capture || !visible) fail('selected capture is absent')
  const [x, y] = input.pixel
  if (x >= capture.image.width || y >= capture.image.height) fail('selected pixel is outside image')
  const camera = createCalibratedCamera(run.plan.config.survey.calibration, run.plan.config.survey.heldOut), origin = visible.pose.cameraPositionM
  const ray = rotateBodyToNed(visible.pose.quaternionWxyz, camera.bodyRay([x + 0.5, y + 0.5])), terrain = run.plan.config.survey.terrain
  const denominator = ray[2] - terrain.gradient[0] * ray[0] - terrain.gradient[1] * ray[1]
  const depth = (terrain.downAtOriginM + terrain.gradient[0] * origin[0] + terrain.gradient[1] * origin[1] - origin[2]) / denominator
  if (denominator <= 1e-6 || !Number.isFinite(depth) || depth <= 0) fail('selected pixel does not intersect terrain')
  camera.bodyPoint([x + 0.5, y + 0.5], depth)
  const positionM = origin.map((n, i) => n + ray[i]! * depth) as SensorVector, point: [number, number] = [positionM[0], positionM[1]], config = run.plan.config.survey
  if (!volumeInsideRing(point, config.boundary) || config.holes.some(hole => volumeInsideRing(point, hole))) fail('selected animal pixel is outside field or inside a hole')
  const parcelIds = run.plan.config.parcels.filter(parcel => positionM[0] >= parcel.boundsM[0] && positionM[1] >= parcel.boundsM[1] && positionM[0] <= parcel.boundsM[2] && positionM[1] <= parcel.boundsM[3]).map(parcel => parcel.id)
  if (!parcelIds.length) fail('selected animal pixel is outside a parcel')
  const distance = Math.hypot(...ray) * depth
  const positionSigmaM = visible.pose.positionSigmaM + distance * (visible.pose.attitudeSigmaRad + camera.calibration.uncertainty.rotationSigmaRad + camera.pixelRaySigma) + camera.calibration.uncertainty.modelSigmaM + camera.calibration.uncertainty.depthSigmaM
  return { ...input, version: 1, visitId: run.visitId, selection: 'explicit-operator-selected-animal', captureSha256: await sourceDigest(run, capture), positionM, geodetic: nedToGeodetic(positionM, config.origin), positionSigmaM, parcelIds, identityAuthenticated: false, physicalAnimalVerified: false }
}
/** An animal identifier is an operator label. No detector or model truth assigns species, identity or presence. */
export async function createLivestockObservation(input: AgricultureRun, declaration: LivestockObservationInput): Promise<LivestockObservation> {
  return observe(validateAgricultureRun(input), observationInput(declaration))
}
function declaredObservation(input: unknown) {
  bounded(input)
  fields(input, ['id', 'animalId', 'captureId', 'pixel', 'observerId', 'observedAt', 'note', 'version', 'visitId', 'selection', 'captureSha256', 'positionM', 'geodetic', 'positionSigmaM', 'parcelIds', 'identityAuthenticated', 'physicalAnimalVerified'])
  const v = input as LivestockObservation
  return { original: observationInput({ id: v.id, animalId: v.animalId, captureId: v.captureId, pixel: v.pixel, observerId: v.observerId, observedAt: v.observedAt, note: v.note }), declared: structuredClone(v) }
}
async function checkedObservation(run: AgricultureRun, item: ReturnType<typeof declaredObservation>) {
  const expected = await observe(run, item.original)
  if (!same(expected, item.declared)) fail('animal observation differs from source digest, pixel or explicit label')
  return expected
}
export async function validateLivestockObservation(input: AgricultureRun, declaration: unknown): Promise<LivestockObservation> {
  const run = validateAgricultureRun(input), item = declaredObservation(declaration)
  return checkedObservation(run, item)
}
export async function validateLivestockObservations(input: AgricultureRun, declarations: unknown): Promise<LivestockObservation[]> {
  const run = validateAgricultureRun(input)
  if (!Array.isArray(declarations) || declarations.length > agricultureEvidenceLimits.observations) fail('animal observation resource bound')
  bounded(declarations)
  const items = declarations.map(declaredObservation), ids = new Set<string>()
  for (const item of items) { if (ids.has(item.original.id)) fail('duplicate animal observation identity'); ids.add(item.original.id) }
  const result: LivestockObservation[] = []
  for (const item of items) result.push(await checkedObservation(run, item))
  return result
}
