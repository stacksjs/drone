import type { AgricultureConfig, AgricultureLayer, AgricultureRun, AgricultureScenario } from './types'
import type { MissionSnapshot } from '../missions/engine'
import type { FarmingProducerObservation } from './farming-producer'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { readMissionFile } from '../missions/files'
import { assertMissionSimulationOrigin } from '../missions/simulation'
import { compileSurveyMission } from '../mapping/runtime'
import { surveyDatasetLimits } from '../mapping/quality'
import { agricultureEvidenceLimits, agricultureRecordingJson, parseAgricultureRecording, validateAgricultureRun } from './evidence'
import { writeAgricultureDataset } from './export'
import { observeFarmingProducer } from './farming-producer'
import { processAgriculture } from './layer'
import { createAgriculturePlan } from './planner'
import { agricultureScenarios, simulateAgriculture } from './runtime'

export interface FarmingCollectionRequest {
  version: 1
  operation: 'agriculture-synthetic-collection'
  requestId: string
  context: { farmId: number, fieldId: number, declarationId: string }
  geometry: {
    frame: 'LOCAL_NED'
    horizontalUnit: 'm'
    heightDatum: 'WGS84_ELLIPSOID'
    evidence: 'operator-declared-metric'
    sourceReference: string
  }
  simulation: {
    visitId: string
    scenario: AgricultureScenario
    seconds: number
  }
  config: AgricultureConfig
}

export interface FarmingCollectionRecord {
  version: 1
  kind: 'farming-synthetic-collection-preview'
  operation: 'agriculture-synthetic-collection'
  requestId: string
  context: FarmingCollectionRequest['context']
  geometry: FarmingCollectionRequest['geometry']
  source: { encoding: 'utf-8', byteLength: number, sha256: string }
  producer: { path: 'attempt/producer.json', byteLength: number, sha256: string, evidence: 'observed-software-content-identities' }
  simulation: FarmingCollectionRequest['simulation']
  outcome: {
    status: AgricultureRun['status']
    reason: string
    captures: number
    boardNeutral: true
    lastMissionResult: MissionSnapshot
    compactMissionReplayPerformed: true
  }
  dataset: {
    manifestPath: 'dataset/manifest.json'
    manifestByteLength: number
    manifestSha256: string
    recordingPath: 'dataset/recording.json'
    recordingByteLength: number
    recordingSha256: string
  }
  layer: AgricultureLayer
  synthetic: true
  ownershipVerified: false
  geometryVerified: false
  physicalFlightEnabled: false
  physicalCalibrationVerified: false
  physicalAgronomyVerified: false
  dispatchPerformed: false
  operationalMissionCompleted: false
  fullSensorReplayPerformed: false
}
export interface FarmingCollectionDelivery {
  version: 1
  kind: 'farming-synthetic-collection-delivery'
  record: FarmingCollectionRecord
  attempt: { manifestPath: 'attempt/manifest.json', manifestByteLength: number, manifestSha256: string }
}

function unavailable(): never { throw new Error('farming-collection-unavailable') }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function ordinary(value: unknown, active = new Set<object>()): void {
  if (typeof value === 'number') { if (!Number.isFinite(value)) unavailable(); return }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value !== 'object' || active.has(value)) unavailable()
  const array = Array.isArray(value)
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) unavailable()
  active.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1) unavailable()
    for (let index = 0; index < length.value; index++) if (!Object.hasOwn(descriptors, String(index))) unavailable()
  }
  for (const key of keys) {
    if (array && key === 'length') continue
    if (typeof key !== 'string') unavailable()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unavailable()
    if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) unavailable()
    ordinary(descriptor.value, active)
  }
  active.delete(value)
}
function json(value: unknown, maxBytes: number, pretty = false): string {
  ordinary(value)
  const text = JSON.stringify(value, null, pretty ? 2 : undefined) + '\n'
  if (Buffer.byteLength(text) > maxBytes) throw new RangeError('farming-collection-limit')
  return text
}

function invalid(): never { throw new TypeError('farming-collection-input') }
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const keys = Object.keys(value)
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) invalid()
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid()
}
function rowId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid()
}
function declaration(text: string): { request: FarmingCollectionRequest, bytes: Uint8Array } {
  if (typeof text !== 'string' || text.length === 0) invalid()
  if (text.length > 262144) throw new RangeError('farming-collection-limit')
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = text.charCodeAt(++index)
      if (!(low >= 0xDC00 && low <= 0xDFFF)) invalid()
    }
    else if (code >= 0xDC00 && code <= 0xDFFF) invalid()
  }
  let bytes: Uint8Array
  try { bytes = new TextEncoder().encode(text) }
  catch { return unavailable() }
  if (bytes.byteLength > 262144) throw new RangeError('farming-collection-limit')
  let input: unknown
  try { input = JSON.parse(text) }
  catch { return invalid() }
  fields(input, ['version', 'operation', 'requestId', 'context', 'geometry', 'simulation', 'config'])
  if (input.version !== 1 || input.operation !== 'agriculture-synthetic-collection') invalid()
  const requestId = input.requestId
  identifier(requestId)
  const context = input.context
  fields(context, ['farmId', 'fieldId', 'declarationId'])
  const { farmId, fieldId, declarationId } = context
  rowId(farmId); rowId(fieldId); identifier(declarationId)
  const geometry = input.geometry
  fields(geometry, ['frame', 'horizontalUnit', 'heightDatum', 'evidence', 'sourceReference'])
  if (geometry.frame !== 'LOCAL_NED' || geometry.horizontalUnit !== 'm' || geometry.heightDatum !== 'WGS84_ELLIPSOID' || geometry.evidence !== 'operator-declared-metric') invalid()
  const sourceReference = geometry.sourceReference
  identifier(sourceReference)
  const simulation = input.simulation
  fields(simulation, ['visitId', 'scenario', 'seconds'])
  const { visitId, scenario, seconds } = simulation
  identifier(visitId)
  if (!agricultureScenarios.includes(scenario as AgricultureScenario) || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) invalid()
  return {
    request: {
      version: 1, operation: 'agriculture-synthetic-collection', requestId,
      context: { farmId, fieldId, declarationId },
      geometry: { frame: 'LOCAL_NED', horizontalUnit: 'm', heightDatum: 'WGS84_ELLIPSOID', evidence: 'operator-declared-metric', sourceReference },
      simulation: { visitId, scenario: scenario as AgricultureScenario, seconds },
      config: input.config as AgricultureConfig,
    },
    bytes,
  }
}

/** Retain an owned synthetic collection. The host provisions the private parent, never a remote declaration. */
export async function collectFarmingObservation(requestJson: string, directory: string): Promise<FarmingCollectionDelivery> {
  const { request, bytes } = declaration(requestJson)
  if (typeof structuredClone !== 'function') return unavailable()
  try {
    const plan = createAgriculturePlan(request.config)
    assertMissionSimulationOrigin(compileSurveyMission(plan.survey).origin)
    const calibration = plan.survey.config.calibration
    if (plan.config.radiometry.evidence !== 'synthetic' || calibration.evidence !== 'synthetic' || calibration.output.width * calibration.output.height > agricultureEvidenceLimits.pixels || calibration.timing.clockUncertaintyMs > surveyDatasetLimits.clockUncertaintyMs) throw new Error('Unexecutable collection configuration')
    request.config = plan.config
  }
  catch { throw new Error('farming-collection-rejected') }
  if (typeof directory !== 'string' || directory.length < 1 || directory.length > 4096 || directory.includes('\0')) invalid()
  try {
    const root = resolve(directory)
    const before = await observeFarmingProducer()
    const producer: FarmingProducerObservation = { ...before, observationInterval: 'before-collection-and-after-dataset-readback', observationsUnchanged: true }
    // This private intended document is published only after the matching second observation.
    const producerJson = json(producer, 131072)
    await mkdir(root, { mode: 0o700 })
    let recording: string
    {
      const generated = validateAgricultureRun(simulateAgriculture({ config: request.config, ...request.simulation }))
      recording = agricultureRecordingJson(generated)
    }
    const run = parseAgricultureRecording(recording)
    const layer = processAgriculture(run)
    const last = run.survey.trace.rows.at(-1)?.result
    if (run.survey.boardNeutral !== true || !last) return unavailable()
    if (run.status === 'incomplete') {
      if (!['ready', 'running', 'paused'].includes(last.state)) return unavailable()
    }
    else if (last.state !== run.status || last.targetM !== null) return unavailable()
    const record: FarmingCollectionRecord = {
      version: 1, kind: 'farming-synthetic-collection-preview', operation: 'agriculture-synthetic-collection', requestId: request.requestId,
      context: request.context, geometry: request.geometry,
      source: { encoding: 'utf-8', byteLength: bytes.byteLength, sha256: hash(bytes) },
      producer: { path: 'attempt/producer.json', byteLength: Buffer.byteLength(producerJson), sha256: hash(producerJson), evidence: 'observed-software-content-identities' },
      simulation: request.simulation,
      outcome: { status: run.status, reason: run.reason, captures: run.captures.length, boardNeutral: true, lastMissionResult: structuredClone(last), compactMissionReplayPerformed: true },
      // Private preflight placeholders use the maximum admitted marker byte count. None is persisted.
      dataset: { manifestPath: 'dataset/manifest.json', manifestByteLength: 16777216, manifestSha256: '0'.repeat(64), recordingPath: 'dataset/recording.json', recordingByteLength: Buffer.byteLength(recording), recordingSha256: hash(recording) },
      layer, synthetic: true, ownershipVerified: false, geometryVerified: false, physicalFlightEnabled: false, physicalCalibrationVerified: false, physicalAgronomyVerified: false, dispatchPerformed: false, operationalMissionCompleted: false, fullSensorReplayPerformed: false,
    }
    json(record, 16776192)
    const dataset = await writeAgricultureDataset(join(root, 'dataset'), run)
    // Read back sequentially. These compare exact retained bytes, not only intended in-memory hashes.
    if (await readMissionFile(join(root, 'dataset/recording.json'), { maxBytes: 16777216, preserveBom: true }) !== recording) return unavailable()
    if (await readMissionFile(join(root, 'dataset/layer.json'), { maxBytes: 16777216, preserveBom: true }) !== json(layer, 16777216, true)) return unavailable()
    const datasetManifest = await readMissionFile(join(root, 'dataset/manifest.json'), { maxBytes: 16777216, preserveBom: true })
    if (hash(datasetManifest) !== dataset.manifestSha256) return unavailable()
    const after = await observeFarmingProducer()
    if (JSON.stringify(before) !== JSON.stringify(after)) return unavailable()
    record.dataset.manifestByteLength = Buffer.byteLength(datasetManifest)
    record.dataset.manifestSha256 = hash(datasetManifest)
    const resultJson = json(record, 16776192)
    const entries = [
      { path: 'request.json', contents: requestJson },
      { path: 'producer.json', contents: producerJson },
      { path: 'result.json', contents: resultJson },
      { path: 'dataset-manifest.json', contents: datasetManifest },
    ]
    const manifestJson = json({
      version: 1, kind: 'farming-synthetic-collection-attempt', requestId: request.requestId, visitId: run.visitId,
      evidence: 'owned-agriculture-physics-simulation', status: run.status, reason: run.reason, synthetic: true, physicalFlightEnabled: false,
      contentAuthentication: 'unsigned-content-hashes',
      files: entries.map(entry => ({ path: entry.path, byteLength: Buffer.byteLength(entry.contents), sha256: hash(entry.contents) })),
    }, 16384, true)
    const delivery: FarmingCollectionDelivery = { version: 1, kind: 'farming-synthetic-collection-delivery', record, attempt: { manifestPath: 'attempt/manifest.json', manifestByteLength: Buffer.byteLength(manifestJson), manifestSha256: hash(manifestJson) } }
    json(delivery, 16777216)
    await writeCompletedArtifact(join(root, 'attempt'), entries, manifestJson)
    if (await readMissionFile(join(root, 'attempt/manifest.json'), { maxBytes: 16384, preserveBom: true }) !== manifestJson) return unavailable()
    return delivery
  }
  catch (error) {
    if (error instanceof RangeError && error.message === 'farming-collection-limit') throw error
    return unavailable()
  }
}
