/** Shared only inside this process, including independently bundled native Actions. */
interface ProcessOwner { version: 1, pendingChecks: number, slot: unknown | null }
const key = Symbol.for('@stacksjs/drone:incident-execution-owner:v1')
export function executionOwner(): ProcessOwner {
  const global = globalThis as Record<symbol, unknown>
  if (global[key] === undefined) Object.defineProperty(global, key, { value: { version: 1, pendingChecks: 0, slot: null }, writable: false, configurable: false })
  const value = global[key]
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || !('version' in value) || value.version !== 1 || !('pendingChecks' in value) || !Number.isSafeInteger(value.pendingChecks) || (value.pendingChecks as number) < 0 || !('slot' in value)) throw new Error('Execution process owner is incompatible')
  return value as ProcessOwner
}
