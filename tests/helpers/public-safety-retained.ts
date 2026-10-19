import type { RetentionPreview, PurgedCustodyProjection } from '../../resources/functions/drone/public-safety/retention/types'
import assert from 'node:assert/strict'

/** Existing retained-only fixtures must fail if they unexpectedly receive a completed tombstone. */
export function retainedPreview(value: RetentionPreview | PurgedCustodyProjection): RetentionPreview {
  assert(!('purged' in value), 'Fixture requires an incident whose custody payload has not been purged')
  return value
}
