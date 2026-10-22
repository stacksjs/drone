/** Bounded own error descriptors only, including actual SQLite/OS aggregate causes. */
export function storageErrorCodes(error: unknown) {
  const pending = [error], seen = new Set<unknown>(), codes: string[] = []
  while (pending.length && seen.size < 32) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    const code = Object.getOwnPropertyDescriptor(item, 'code')?.value
    if ((typeof code === 'string' || typeof code === 'number') && String(code).length <= 64) codes.push(String(code))
    const cause = Object.getOwnPropertyDescriptor(item, 'cause')?.value
    if (cause !== undefined) pending.push(cause)
    const errors = Object.getOwnPropertyDescriptor(item, 'errors')?.value
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 32))
  }
  return codes
}
