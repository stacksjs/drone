import type { InspectionReview, InspectionRun } from './types'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createImageData, encode } from 'ts-images'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { inspectionEvidenceLimits, inspectionRecordingJson, validateInspectionReviews, validateInspectionRun } from './evidence'

function sha256(bytes: string | Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }

/** Private, exclusive local dataset. The shared writer publishes manifest.json after all content and filesystem barriers. */
export async function writeInspectionDataset(directory: string, input: InspectionRun, declarations: readonly InspectionReview[] = []): Promise<{ directory: string, manifest: string, recording: string, images: number, manifestSha256: string }> {
  if (typeof directory !== 'string' || directory.length < 1 || directory.length > 4096 || directory.includes('\0')) throw new TypeError('Invalid inspection export directory')
  const run = validateInspectionRun(input)
  // The batch API snapshots all declarations before its first asynchronous digest.
  const reviews = await validateInspectionReviews(run, declarations)
  const recordingJson = inspectionRecordingJson(run)
  const entries: { path: string, contents: string | Uint8Array }[] = [{ path: 'recording.json', contents: recordingJson }, { path: 'reviews.json', contents: json(reviews) }]
  const images: Record<string, unknown>[] = []
  let imageBytes = 0
  for (const capture of run.captures) {
    const image = createImageData(capture.image.width, capture.image.height, { hasAlpha: true, bitDepth: 8 })
    image.data.set(capture.image.rgba)
    const png = await encode(image, 'png')
    const thermal = new Uint8Array(capture.image.thermalCentiKelvin.length * 2), view = new DataView(thermal.buffer)
    for (let i = 0; i < capture.image.thermalCentiKelvin.length; i++) view.setUint16(i * 2, capture.image.thermalCentiKelvin[i]!, true)
    imageBytes += png.length + thermal.length
    if (imageBytes > inspectionEvidenceLimits.rawBytes) throw new RangeError('Inspection encoded images exceed resource bound')
    const visiblePath = `images/${capture.id}.png`, thermalPath = `thermal/${capture.id}.uint16le`, metadataPath = `thermal/${capture.id}.json`
    const metadata = {
      version: 1, captureId: capture.id, visitId: capture.visitId, assetId: capture.assetId, revision: capture.revision,
      capturedAtMs: capture.capturedAtMs, reference: capture.pose.reference, clockDomain: 'fixture-monotonic-ms',
      width: capture.image.width, height: capture.image.height, encoding: 'uint16-little-endian-row-major-top-left',
      unit: 'centikelvin', kelvinPerCount: 0.01, nodata: 0, evidence: 'ideal-synthetic-surface-temperature-field',
      physicalRadiometryVerified: false, emissivityCorrectionPerformed: false, reflectedBackgroundCorrectionPerformed: false,
      atmosphereCorrectionPerformed: false, nucVerified: false, netdVerified: false,
      sourcePath: thermalPath, sourceSha256: sha256(thermal), sourceBytes: thermal.length,
      limitations: 'Synthetic ray-intersected temperature field. These counts are not RGB intensity, calibrated physical temperature or automatic defect evidence.',
    }
    entries.push({ path: visiblePath, contents: png }, { path: thermalPath, contents: thermal }, { path: metadataPath, contents: json(metadata) })
    const captureMetadata = Object.fromEntries(Object.entries(capture).filter(([key]) => key !== 'image'))
    images.push({ ...captureMetadata, visiblePath, thermalPath, thermalMetadataPath: metadataPath, width: capture.image.width, height: capture.image.height })
  }
  entries.push({ path: 'quality.json', contents: json({ version: 1, visitId: run.visitId, status: run.status, reason: run.reason, boardNeutral: run.boardNeutral, minimumObservedSeparationM: run.minimumObservedSeparationM, minimumSeparationEvidence: 'independent-simulation-plant-truth-only', stations: run.plan.stations.map(station => ({ stationId: station.id, captureId: run.captures.find(capture => capture.stationId === station.id)?.id ?? null, quality: run.captures.find(capture => capture.stationId === station.id)?.quality ?? null })), physicalInspectionVerified: false }) })
  entries.push({ path: 'README.txt', contents: [
    'Drone bridge-face inspection dataset, version 1', '',
    'recording.json is a bounded owned-runtime simulation recording, including original visible and thermal numeric pixels.',
    'images/ contains losslessly encoded RGBA PNG rasters. thermal/ contains independent uint16 little-endian centikelvin fields and their metadata.',
    'Thermal zero denotes background/nodata. Each nonzero count represents 0.01 kelvin in an ideal synthetic surface temperature model.',
    'No emissivity, reflected-background, atmospheric, NUC or NETD qualification establishes physical radiometry.',
    'Capture positions use estimated LOCAL_NED and a fixed WGS84 ellipsoid origin. Camera metadata includes calibrated lever arm, exposure and declared uncertainty.',
    'Compact mission replay verifies recorded decisions and pose epochs. Omitted raw sensors and board/estimator internal state are not replayed.',
    'quality.json reports station capture predicates and independent modeled clearance. Completion does not establish asset coverage or physical inspection accuracy.',
    'reviews.json contains only explicitly supplied operator declarations. Their hashes bind source image bytes and capture metadata, without authenticating identities or certifying defects.',
    'No automatic diagnosis, deterioration comparison or physical defect proof is provided.',
    'manifest.json is the completion marker after exclusive private files and filesystem durability barriers. Content hashes are unsigned.',
    'Local hard-link and directory-fsync support is required. Storage hardware power-loss durability has not been tested.', '',
  ].join('\n') })
  const manifest = {
    version: 1, kind: 'asset-relative-inspection-dataset', evidence: run.evidence, visitId: run.visitId,
    assetId: run.plan.config.asset.id, revision: run.plan.config.asset.revision, status: run.status, imageCount: images.length, reviewCount: reviews.length,
    physicalFlightEnabled: false, physicalInspectionVerified: false, physicalRadiometryVerified: false, physicalCalibrationVerified: false,
    contentAuthentication: 'unsigned-content-hashes', compactReplay: 'mission-decisions-and-declared-pose-epoch-consistency', fullSensorReplayPerformed: false,
    persistence: { protocol: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false },
    localFrame: 'LOCAL_NED', axes: 'NORTH_EAST_DOWN', opticalAxes: 'RIGHT_DOWN_FORWARD', quaternionConvention: 'WXYZ_BODY_FRD_TO_LOCAL_NED',
    asset: run.plan.config.asset, calibration: run.plan.config.calibration, calibrationValidationSamples: run.plan.config.heldOut,
    headingAlignment: 'initial-simulation-north', absoluteHeadingObserved: false, clockDomain: 'fixture-monotonic-ms', utcAvailable: false,
    temperatureEvidence: 'ideal-synthetic-surface-temperature-field', images,
    files: entries.map(entry => ({ path: entry.path, bytes: typeof entry.contents === 'string' ? Buffer.byteLength(entry.contents) : entry.contents.length, sha256: sha256(entry.contents) })),
  }
  const manifestJson = json(manifest)
  if (Buffer.byteLength(manifestJson) > inspectionEvidenceLimits.manifestBytes) throw new RangeError('Inspection manifest exceeds resource bound')
  const output = await writeCompletedArtifact(directory, entries, manifestJson, { directories: ['images', 'thermal'] })
  return { ...output, recording: join(output.directory, 'recording.json'), images: images.length, manifestSha256: sha256(manifestJson) }
}
