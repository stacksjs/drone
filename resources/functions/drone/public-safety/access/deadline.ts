import { PublicSafetyAccessError } from './errors'

// Private object identity metadata, never a response field, header or reusable capability.
const deadlines = new WeakMap<object, number>()

export function incidentDeadline(value: unknown): number | undefined {
  return value !== null && typeof value === 'object' ? deadlines.get(value) : undefined
}
export function associateIncidentDeadline<T extends object>(value: T, deadline: number | undefined): T {
  if (deadline !== undefined) {
    const existing = deadlines.get(value)
    deadlines.set(value, existing === undefined ? deadline : Math.min(existing, deadline))
  }
  return value
}
export function assertIncidentDeadline(value: unknown): void {
  const deadline = incidentDeadline(value)
  if (deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline)) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
}
/** Check after the transaction's actual COMMIT resolves, without changing the public DTO. */
export async function checkedIncidentResult<T>(pending: Promise<T>): Promise<T> {
  const value = await pending
  assertIncidentDeadline(value)
  return value
}
