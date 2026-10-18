import type { SurveyRun } from './types'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createImageData, encode } from 'ts-images'
import { surveyDatasetLimits, surveyQuality, validateSurveyDataset } from './quality'

function sha256(bytes: string | Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
/**
 * Server-only local export. A new private directory and wx writes prevent
 * replacement. manifest.json is written last as the completion marker.
 * Incomplete directories are retained for diagnosis; hashes are not signatures.
 */
export async function writeSurveyDataset(directory: string, input: SurveyRun) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4096 || directory.includes('\0')) throw new TypeError('Invalid survey export directory')
  validateSurveyDataset(input)
  const run = structuredClone(input)
  const quality = surveyQuality(run)
  const encoded: { filename: string, bytes: Uint8Array }[] = []
  const images: Record<string, unknown>[] = []
  let encodedBytes = 0
  // Validate and encode everything before touching the destination. Detaching
  // above keeps mutation during an asynchronous codec call out of the dataset.
  for (const capture of run.captures) {
    const image = createImageData(capture.width, capture.height, { hasAlpha: true, bitDepth: 8 })
    image.data.set(capture.rgba)
    const bytes = await encode(image, 'png')
    encodedBytes += bytes.length
    if (encodedBytes > surveyDatasetLimits.rawBytes) throw new RangeError('Encoded survey dataset exceeds resource bound')
    encoded.push({ filename: capture.filename, bytes })
    const metadata = Object.fromEntries(Object.entries(capture).filter(([key]) => key !== 'rgba'))
    images.push({ ...metadata, mimeType: 'image/png', byteLength: bytes.length, sha256: sha256(bytes) })
  }
  const planJson = JSON.stringify(run.plan), traceJson = JSON.stringify(run.trace)
  const manifest = {
    version: 1, evidence: run.evidence, physicalFlightEnabled: false, collectionOnly: true, reconstructionPerformed: false,
    physicalAccuracyVerified: false, contentAuthentication: 'unsigned-content-hashes',
    renderer: { id: 'ned-checker-landmarks', version: 1, seed: null, exposureModel: 'instantaneous-midpoint', rollingShutterModeled: false },
    absoluteHeadingObserved: false, uncertaintyEvidence: 'declared-fixture-bounds',
    horizontalCrs: 'EPSG:4326', axisOrder: 'longitude-latitude', angleUnit: 'degree', heightUnit: 'metre', heightDatum: 'WGS84_ELLIPSOID',
    localFrame: 'LOCAL_NED', quaternionConvention: 'WXYZ_BODY_FRD_TO_LOCAL_NED', opticalAxes: 'RIGHT_DOWN_FORWARD',
    clockDomain: 'fixture-monotonic-ms', utcAvailable: false, headingAlignment: 'initial-simulation-north',
    status: run.status, reason: run.reason, boardNeutral: run.boardNeutral, imageCount: images.length,
    origin: run.plan.config.origin, cameraCalibration: run.plan.config.calibration, calibrationValidationSamples: run.plan.config.heldOut,
    physicalCalibrationVerified: false, nativePhotogrammetryCameraOverride: false,
    planSha256: sha256(planJson), traceSha256: sha256(traceJson), plan: run.plan, mission: run.mission, trace: run.trace, path: run.path,
    images,
  }
  const geo = ['EPSG:4326', ...run.captures.map(c => `${c.filename} ${c.pose.geodetic.longitudeDeg} ${c.pose.geodetic.latitudeDeg} ${c.pose.geodetic.ellipsoidHeightM}`)].join('\n') + '\n'
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`, qualityJson = `${JSON.stringify(quality, null, 2)}\n`
  if (new TextEncoder().encode(manifestJson).length > surveyDatasetLimits.metadataBytes) throw new RangeError('Survey manifest exceeds resource bound')
  const readme = [
    'Drone survey collection dataset, version 1',
    '',
    'This is synthetic collection evidence from the owned runtime. No photogrammetric reconstruction has been performed.',
    'manifest.json is the completion marker. Its SHA-256 digests identify bytes but are unsigned and do not authenticate their producer.',
    'images/ contains original exported RGBA PNG rasters. geo.txt is an ODM-style image geolocation input with four columns:',
    'filename longitude_degrees latitude_degrees ellipsoid_height_metres',
    'The EPSG:4326 header describes horizontal coordinates. The third coordinate is explicitly WGS84 ellipsoid height, not AGL or MSL.',
    'Camera positions include the declared body-to-optical-center lever arm. Capture pose and native Brown5 calibration remain in manifest.json.',
    'Fixture monotonic capture times have no UTC mapping. Heading is an initial simulation north assumption, not an observed absolute heading.',
    'No measured RTK, PPK or GCP inputs are available. No gcp_list.txt or photogrammetry-native camera override is supplied.',
    'Do not interpret planned GSD, sampled footprint coverage or pose uncertainty as measured reconstruction or physical survey accuracy.',
    'quality.json describes planned and collected evidence, gaps and explicit limitations. A completed flight can still produce partial coverage.',
    'The files follow documented ODM inputs; an external processor has not been executed against this dataset.',
    'ODM format reference: https://docs.opendronemap.org/geo/',
    'ODM input source: https://github.com/OpenDroneMap/ODM/blob/77439b1f45ceb4775b826f900916c64f03736331/opendm/geo.py',
    '',
  ].join('\n')
  const target = resolve(directory)
  await mkdir(target, { mode: 0o700 })
  await mkdir(join(target, 'images'), { mode: 0o700 })
  for (const image of encoded) await writeFile(join(target, 'images', image.filename), image.bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(join(target, 'geo.txt'), geo, { flag: 'wx', mode: 0o600 })
  await writeFile(join(target, 'quality.json'), qualityJson, { flag: 'wx', mode: 0o600 })
  await writeFile(join(target, 'README.txt'), readme, { flag: 'wx', mode: 0o600 })
  const manifestPath = join(target, 'manifest.json')
  await writeFile(manifestPath, manifestJson, { flag: 'wx', mode: 0o600 })
  return { directory: target, manifest: manifestPath, quality: join(target, 'quality.json'), images: images.length, manifestSha256: sha256(manifestJson) }
}
