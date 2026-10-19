import type { RigidBodyState } from '../controls/physics'
import type { ModeledShutterCommand } from './modeled-shutter'
import { createModeledShutter } from './modeled-shutter'

export type { ModeledShutterCommand } from './modeled-shutter'
export interface ModeledImage { rgba: Uint8Array, thermalCentiKelvin: Uint16Array | null }
export interface ModeledShutterAck extends ModeledShutterCommand, ModeledImage { capturedAtMs: number, acknowledgedAtMs: number }
/** Visible/thermal adapter retains the existing flattened raster ACK. */
export function createModeledCamera(renderer: (state: RigidBodyState, nowMs: number) => ModeledImage, options: { fault?: 'none' | 'loss' | 'wrong-ack', faultAfterMs?: number } = {}) {
  const shutter = createModeledShutter(renderer, image => {
    if (!(image.rgba instanceof Uint8Array) || image.rgba.length < 4 || image.rgba.length > 65536 * 4 || image.rgba.length % 4 !== 0 || (image.thermalCentiKelvin !== null && (!(image.thermalCentiKelvin instanceof Uint16Array) || image.thermalCentiKelvin.length !== image.rgba.length / 4))) throw new RangeError('Invalid modeled raster budget')
    return { rgba: new Uint8Array(image.rgba), thermalCentiKelvin: image.thermalCentiKelvin === null ? null : new Uint16Array(image.thermalCentiKelvin) }
  }, options)
  return {
    render: shutter.render,
    request: shutter.request,
    poll(nowMs: number): ModeledShutterAck | null {
      const ack = shutter.poll(nowMs)
      if (!ack) return null
      const { image, ...scope } = ack
      return { ...scope, ...image }
    },
    close: shutter.close,
  }
}
