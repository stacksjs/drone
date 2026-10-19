import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { publicSafetyEvidenceLimits } from '../resources/functions/drone/public-safety/evidence'
import { simulatePublicSafety } from '../resources/functions/drone/public-safety/runtime'
import { renderPublicSafetyDataset } from '../resources/functions/drone/public-safety/export'
// Explicit qualification for the documented pinned profile, not a flight or power-loss test.
// A version/source change requires reviewing the derivation before updating these assertions.
const project = resolve(import.meta.dir, '..')
const hash = (path: string) => createHash('sha256').update(readFileSync(resolve(project, path))).digest('hex')
assert.equal(Bun.version, '1.4.3', 'Requalify the Bun compression implementation')
assert.equal(process.versions.zlib, '12731092979c6d07f42da27da673a9f6c7b13586', 'Requalify the zlib implementation')
assert.equal(JSON.parse(readFileSync(resolve(project, 'node_modules/ts-images/package.json'), 'utf8')).version, '0.2.31')
const qualifiedSources = {
  'node_modules/ts-images/dist/chunk-5z5cky6h.js': '0151ff3f2723494f9b0c47073c40972d04cef164c7b1b0538aeea1ab092ee978',
  'node_modules/ts-images/dist/chunk-8edz5tfp.js': '20c31345f33e3252cd9583881443c82b66a21e371fedbc823c34667a1f334d22',
  'resources/functions/drone/public-safety/export.ts': '89f9bca35bf92c55cd34325fdacd439b5739c8e3f20c983b028a678fa7fc0a45',
  'resources/functions/drone/public-safety/evidence.ts': 'f20a9a999756515322d63352f63c2ec4d95a5bc057457390c7fb837da1634bfc',
  'resources/functions/drone/public-safety/camera.ts': 'b38f628adf9ab036ffd1cba7c87789f0284949d2e7c0c88d3be6f8f2577189e7',
  'resources/functions/drone/public-safety/planner.ts': 'a3c988a0909058bbdfaa35354adaa04318293a9c047527aaf7be4b2024835bd6',
  'resources/functions/drone/public-safety/runtime.ts': '1784062201fd3f77a3fbef0a1ec50b917c1e163ead6be19e266fed8ac6a49aad',
  'resources/functions/drone/mapping/runtime.ts': '924f94fcda5b0114d2c8665ac3186e949cf7396b7eb8ec9baef0e4ef96a499e0'
} as const
for (const [path, expected] of Object.entries(qualifiedSources)) assert.equal(hash(path), expected, `Requalify changed source: ${path}`)
const data = await renderPublicSafetyDataset(simulatePublicSafety({ seconds: 10 }))
const readmeBytes = Buffer.byteLength(data.files.find(file => file.path === 'README.txt')!.contents)
assert(readmeBytes <= 4096)
const text = 'a'.repeat(256)
const count = 256
const fileCount = 3 * count + 2
const maximum = Number.MAX_SAFE_INTEGER
const upperManifest = {
  version: 1,
  evidence: text,
  replayProfile: text,
  incidentId: text,
  revision: text,
  visitId: text,
  purpose: text,
  retention: { policyId: text, expiresAt: text, hold: text },
  physicalFlightEnabled: false,
  physicalThermalVerified: false,
  identityAuthenticated: false,
  retentionDeletionEnforced: false,
  custody: text,
  status: text,
  faultDemonstrated: false,
  images: Array.from({ length: count }, () => ({
    captureId: text, visible: text, thermal: text, support: text, width: maximum, height: maximum,
  })),
  files: Array.from({ length: fileCount }, () => ({ path: text, bytes: maximum, sha256: 'a'.repeat(64) })),
  persistence: text,
  hardwarePowerLossTested: false,
}
const actual = JSON.parse(data.manifestJson)
assert.deepEqual(Object.keys(actual), Object.keys(upperManifest))
assert.deepEqual(Object.keys(actual.retention).sort(), Object.keys(upperManifest.retention).sort())
assert(actual.images.length > 0 && actual.files.length > 0)
assert.deepEqual(Object.keys(actual.images[0]), Object.keys(upperManifest.images[0]!))
assert.deepEqual(Object.keys(actual.files[0]), Object.keys(upperManifest.files[0]!))
const upperManifestBytes = Buffer.byteLength(JSON.stringify(upperManifest, null, 2)) + 1
assert(upperManifestBytes <= 1024 * 1024)

const source = publicSafetyEvidenceLimits.recordingBytes
const pixels = Math.floor(source / 14)
const filtered = 4 * pixels + Math.ceil(pixels / 16)
const compressed = filtered + Math.ceil(filtered / 8) + Math.ceil(filtered / 64) + 13 * count
const png = compressed + 57 * count
const derivatives = png + 3 * pixels
const upper = source + 1 + 4096 + 1024 * 1024 + derivatives
assert(upper < 32 * 1024 * 1024)
console.log(JSON.stringify({
  sourceCap: source,
  minimumCanonicalPixelBytes: 14,
  pixelBound: pixels,
  filteredBytesBound: filtered,
  allPngBytesBound: png,
  thermalSupportBytesBound: 3 * pixels,
  readmeBytes,
  manifestDominationBytes: upperManifestBytes,
  manifestBudget: 1024 * 1024,
  managedIncludingManifestUpperBound: upper,
  managedCap: 32 * 1024 * 1024,
  headroom: 32 * 1024 * 1024 - upper,
  bun: Bun.version,
  zlibCommit: process.versions.zlib,
  qualifiedSources,
}))
