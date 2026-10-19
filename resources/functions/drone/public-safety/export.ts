import type { PublicSafetyRun } from './runtime-types'
import { createHash } from 'node:crypto'
import { createImageData, encode } from 'ts-images'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { publicSafetyRecordingData, validatePublicSafetyRun } from './evidence'

const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex')
/** Private exclusive offline evidence, with a completion marker. This does not implement incident access or automatic retention deletion. */
export async function writePublicSafetyDataset(directory: string, input: PublicSafetyRun) {
  if (typeof directory !== 'string' || !directory.length || directory.length > 4096 || directory.includes('\0')) throw new TypeError('Invalid public-safety output directory')
  // Complete deterministic verification and snapshot precede asynchronous encoding or filesystem creation.
  const run = validatePublicSafetyRun(input), files: { path: string, contents: string | Uint8Array }[] = []
  const images: { captureId: string, visible: string, thermal: string, support: string, width: number, height: number }[] = []
  let bytes = 0
  const add = (path: string, contents: string | Uint8Array) => {
    bytes += typeof contents === 'string' ? new TextEncoder().encode(contents).length : contents.length
    if (bytes > 32 * 1024 * 1024) throw new RangeError('Public-safety dataset exceeds 32 MiB')
    files.push({ path, contents })
  }
  add('recording.json', `${publicSafetyRecordingData(run)}\n`)
  for (let i = 0; i < run.captures.length; i++) {
    const capture = run.captures[i]!, visible = run.survey.captures[i]!
    const image = createImageData(capture.width, capture.height, { hasAlpha: true, bitDepth: 8 })
    image.data.set(visible.rgba)
    const png = await encode(image, 'png')
    const thermal = new Uint8Array(capture.thermalCentiKelvin.length * 2), view = new DataView(thermal.buffer)
    for (let n = 0; n < capture.thermalCentiKelvin.length; n++) view.setUint16(n * 2, capture.thermalCentiKelvin[n]!, true)
    const paths = { captureId: visible.id, visible: `images/${visible.id}.png`, thermal: `images/${visible.id}.thermal-u16le`, support: `images/${visible.id}.support-u8`, width: capture.width, height: capture.height }
    add(paths.visible, png); add(paths.thermal, thermal); add(paths.support, new Uint8Array(capture.support))
    images.push(paths)
  }
  add('README.txt', [
    'Owned public-safety synthetic collection, version 1',
    'The recording is replayed through the pinned owned sensor/physics/incident/shutter profile before export.',
    'Content hashes are unsigned consistency checks, not authenticated chain of custody.',
    'PNG is actual capture-bound opaque RGBA. Numeric thermal is row-major uint16 little endian in synthetic centikelvin.',
    'Thermal counts are unqualified model values, not measured radiometry or a person/fire detector.',
    'Support bytes: 0 unobserved, 1 observed synthetic ground, 2 privacy-masked before storage. Thermal zero is unavailable.',
    'Truth-ray privacy masking is only a synthetic fixture guarantee. Physical pose/uncertainty masking is unqualified.',
    'Events were emitted during virtual execution. They are not a live external or wall-clock transport feed.',
    'No annotations, operator review, team handover, authenticated incident access or retention deletion are implemented by this collection artifact.',
    'Retention and purpose authority are declarations. Copying this directory does not enforce expiry or legal authority.',
    'Physical outputs are inhibited. Operator authority is fixture-provided. Stopping releases targets and modeled thrust, not a real emergency landing.',
    '',
  ].join('\n'))
  const manifest = {
    version: 1, evidence: run.evidence, replayProfile: run.replayProfile,
    incidentId: run.plan.config.id, revision: run.plan.config.revision, visitId: run.plan.config.visitId,
    purpose: run.plan.config.purpose, retention: run.plan.config.retention,
    physicalFlightEnabled: false, physicalThermalVerified: false, identityAuthenticated: false,
    retentionDeletionEnforced: false, custody: 'unsigned-content-hashes',
    status: run.survey.status, faultDemonstrated: run.faultDemonstrated, images,
    files: files.map(file => ({ path: file.path, bytes: typeof file.contents === 'string' ? new TextEncoder().encode(file.contents).length : file.contents.length, sha256: sha256(file.contents) })),
    persistence: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false,
  }
  return writeCompletedArtifact(directory, files, `${JSON.stringify(manifest, null, 2)}\n`, { directories: ['images'] })
}
