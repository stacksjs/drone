import type { TrackingSnapshot } from './types'

/** Add a visual interlock to an independently positioned metric follow target. */
export function createVisualLockGuard(options: { selectedLockId: string, read: (nowMs: number) => TrackingSnapshot }) {
  const id = options.selectedLockId
  const read = options.read
  if (!id.trim() || typeof read !== 'function') throw new TypeError('Choose a visual lock before creating its guard')
  return (nowMs: number): string | undefined => {
    const snapshot = read(nowMs)
    if (!Number.isFinite(nowMs) || snapshot.state !== 'tracking' || !snapshot.confirmed || !snapshot.observation
      || snapshot.selected?.id !== id || !Number.isFinite(snapshot.selected.lastSeenAtMs)
      || snapshot.selected.lastSeenAtMs > nowMs || nowMs - snapshot.selected.lastSeenAtMs > 500)
      return 'Visual lock lost, unconfirmed, stale or changed'
  }
}
