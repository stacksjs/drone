import { expect, test } from 'bun:test'
import { assertPurgeItemBounds } from '../../resources/functions/drone/public-safety/purge/item-bounds'
function item(kind: 'artifact' | 'file' | 'directory' | 'db-row' = 'file') { return { kind, planned_json: '{}', identity_json: null as string | null, alias_json: null as string | null, arm_json: null as string | null } }

test('private purge metadata counts UTF8 bytes and enforces separate kind and optional JSON budgets', () => {
  for (const [field, maximum] of [['planned_json', 16384], ['identity_json', 16384], ['alias_json', 16384], ['arm_json', 262144]] as const) {
    const target = item()
    target[field] = field === 'alias_json' ? JSON.stringify(['é'.repeat(maximum / 2)]) : 'é'.repeat(maximum / 2 + 1)
    expect(() => assertPurgeItemBounds(target)).toThrow()
  }
  for (const kind of ['file', 'directory', 'db-row'] as const) {
    const target = item(kind); target.planned_json = 'x'.repeat(16384)
    expect(() => assertPurgeItemBounds(target)).not.toThrow()
    target.planned_json += 'x'; expect(() => assertPurgeItemBounds(target)).toThrow()
  }
  const artifact = item('artifact'); artifact.planned_json = 'é'.repeat(2097152)
  expect(() => assertPurgeItemBounds(artifact)).not.toThrow()
  artifact.planned_json += 'é'; expect(() => assertPurgeItemBounds(artifact)).toThrow()
  expect(() => assertPurgeItemBounds({ ...item(), alias_json: '[{}, {}, {}]' })).toThrow()
})
