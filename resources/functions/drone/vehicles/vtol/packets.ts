/** Capture own numeric data without invoking array iterators or index accessors. */
export function numericPacket(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) throw new RangeError('Invalid VTOL numeric packet')
  const packet: number[] = []
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field?.enumerable || !Object.hasOwn(field, 'value') || typeof field.value !== 'number' || !Number.isFinite(field.value)) throw new RangeError('Invalid VTOL numeric packet')
    packet.push(field.value)
  }
  return packet
}
