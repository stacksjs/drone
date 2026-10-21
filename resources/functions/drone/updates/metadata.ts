import { canonicalize } from '@tufjs/canonical-json'
import { sha256 } from './files'

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid signed runtime metadata')
  return value as Record<string, unknown>
}
export function validateMetadata(bytes: Buffer) {
  const signed = object(object(JSON.parse(bytes.toString('utf8'))).signed)
  if (!Number.isSafeInteger(signed.version) || (signed.version as number) < 1) throw new Error('TUF metadata requires a positive safe integer version')
  // Date accepts invalid calendar dates and produces NaN for malformed input. Validate the
  // specified UTC calendar representation before the SDK performs its expiry comparison.
  const expires = signed.expires
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expires) || !Number.isFinite(Date.parse(expires)) || new Date(expires).toISOString().replace('.000Z', 'Z') !== expires) throw new Error('TUF metadata requires a valid UTC expiration date')
  const keys = signed._type === 'root' ? object(signed.keys) : signed._type === 'targets' && signed.delegations !== undefined ? object(object(signed.delegations).keys) : undefined
  // The SDK verifies signatures by key ID but does not recompute the ID. Reject arbitrary
  // identifier aliases by binding each declared ID to the canonical key object.
  for (const [id, key] of Object.entries(keys ?? {})) {
    if (id !== sha256(Buffer.from(canonicalize(object(key))))) throw new Error('TUF key identifier does not match canonical key data')
  }
}
