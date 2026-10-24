export class SurfaceByteRejection extends Error {
  constructor(readonly kind: 'input' | 'budget' | 'unavailable') { super(kind) }
}
function reject(kind: 'input' | 'budget' | 'unavailable' = 'input'): never { throw new SurfaceByteRejection(kind) }

// Only trusted native functions are captured. Caller properties and prototypes are never read.
const nativeBytes = (() => {
  try {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype)
    const length = Object.getOwnPropertyDescriptor(prototype, 'length')?.get
    const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get
    const byteOffset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get
    const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get
    const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)?.get
    const set = Object.getOwnPropertyDescriptor(prototype, 'set')?.value
    const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
    const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (!length || !byteLength || !byteOffset || !buffer || !tag || typeof set !== 'function' || !backingLength || !resizable) return null
    return { length, byteLength, byteOffset, buffer, tag, set, backingLength, resizable }
  }
  catch { return null }
})()

export function captureSurfaceBytes(input: unknown): Uint8Array<ArrayBuffer> {
  if (!nativeBytes) return reject('unavailable')
  let length: unknown, byteLength: unknown, offset: unknown, backing: unknown, backingLength: unknown, resizable: unknown
  try {
    if (Reflect.apply(nativeBytes.tag, input, []) !== 'Uint8Array') return reject()
    length = Reflect.apply(nativeBytes.length, input, [])
    byteLength = Reflect.apply(nativeBytes.byteLength, input, [])
    offset = Reflect.apply(nativeBytes.byteOffset, input, [])
    backing = Reflect.apply(nativeBytes.buffer, input, [])
    // These getters reject SharedArrayBuffer and other non-ArrayBuffer backing.
    backingLength = Reflect.apply(nativeBytes.backingLength, backing, [])
    resizable = Reflect.apply(nativeBytes.resizable, backing, [])
  }
  catch (error) {
    if (error instanceof TypeError || error instanceof SurfaceByteRejection) return reject()
    throw error
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 8 || byteLength !== length || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof backingLength !== 'number' || !Number.isSafeInteger(backingLength) || backingLength < length || offset > backingLength - length || resizable !== false) return reject()
  if (length > 8388608) return reject('budget')
  const owned = new Uint8Array(length)
  Reflect.apply(nativeBytes.set, owned, [input, 0])
  return owned
}
