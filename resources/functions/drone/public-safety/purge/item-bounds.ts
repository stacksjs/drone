import { Buffer } from 'node:buffer'
import { PurgeFileBlocked } from './files'
interface ItemJsonFields { kind?: unknown, planned_json?: unknown, identity_json?: unknown, alias_json?: unknown, arm_json?: unknown }
function bound(value: unknown, maximum: number, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) throw new PurgeFileBlocked('capacity-exceeded')
}
/** Direct native query-builder writes do not invoke model validators. Enforce private item UTF-8 budgets independently by kind. */
export function assertPurgeItemBounds(item: ItemJsonFields): void {
  if (!['artifact', 'file', 'directory', 'db-row'].includes(item.kind as string)) throw new PurgeFileBlocked('capacity-exceeded')
  bound(item.planned_json, item.kind === 'artifact' ? 4194304 : 16384)
  bound(item.identity_json, 16384, true)
  bound(item.alias_json, 16384, true)
  bound(item.arm_json, 262144, true)
  if (item.alias_json !== null) {
    const aliases: unknown = JSON.parse(item.alias_json as string)
    if (!Array.isArray(aliases) || aliases.length > 2) throw new PurgeFileBlocked('capacity-exceeded')
  }
}
