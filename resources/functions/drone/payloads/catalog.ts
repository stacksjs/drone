import type { PayloadBusContract } from './types'
import { PayloadCaptureError } from './types'

/** Validate configuration only. This does not open a bus or grant actuator authority. */
export function validatePayloadBus(contract: PayloadBusContract): void {
  const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max
  const positive = (n: number, max: number) => Number.isFinite(n) && n > 0 && n <= max
  const id = (s: string) => typeof s === 'string' && /^[\w./:-]{1,128}$/.test(s)
  let valid = !!contract && positive(contract.timeoutMs, 2000) && integer(contract.maxTransferBytes, 1, 524288) && contract.maxQueueDepth === 1
  if (valid) {
    switch (contract.kind) {
      case 'csi': valid = contract.model === 'IMX500' && ['CAM/DISP0', 'CAM/DISP1', 'unspecified'].includes(contract.connector); break
      case 'spi': valid = integer(contract.controller, 0, 15) && integer(contract.chipSelect, 0, 15) && integer(contract.mode, 0, 3) && integer(contract.clockHz, 1, 50000000); break
      case 'i2c': valid = integer(contract.controller, 0, 15) && integer(contract.address7bit, 8, 119) && integer(contract.clockHz, 1, 1000000); break
      case 'uart': valid = id(contract.device) && integer(contract.baud, 1200, 3000000); break
      case 'can': case 'dronecan': case 'cyphal': valid = id(contract.interface) && integer(contract.bitrate, 10000, 1000000) && integer(contract.nodeId, 1, 127); break
      case 'gpio': valid = integer(contract.chip, 0, 255) && integer(contract.line, 0, 1023) && [0, 1].includes(contract.inactiveLevel); break
      case 'pwm': valid = positive(contract.frequencyHz, 1000) && positive(contract.minPulseUs, 2500) && positive(contract.maxPulseUs, 2500) && contract.minPulseUs < contract.maxPulseUs && contract.minPulseUs <= contract.neutralPulseUs && contract.neutralPulseUs <= contract.maxPulseUs && contract.maxPulseUs < 1000000 / contract.frequencyHz; break
      case 'dshot': valid = [150, 300, 600].includes(contract.rateKbps) && contract.neutralCommand === 0; break
      case 'power-monitor': valid = ['i2c', 'can', 'adc'].includes(contract.transport) && positive(contract.maxVoltageV, 1000) && positive(contract.maxCurrentA, 10000) && id(contract.calibrationId); break
      default: valid = false
    }
  }
  if (!valid) throw new PayloadCaptureError('invalid', 'Invalid payload bus configuration or timing budget')
}
/** Candidate transports are inventory, not a claim of implemented vendor protocols. */
export const payloadInventory = Object.freeze([
  { family: 'pi-ai-camera', buses: ['csi'], implementation: 'acquisition-adapter', validation: 'fixture-only' },
  { family: 'gimbal', buses: ['uart', 'can', 'pwm'], implementation: 'deferred', validation: 'none' },
  { family: 'lidar-rangefinder', buses: ['uart', 'i2c', 'can', 'dronecan', 'cyphal'], implementation: 'deferred', validation: 'none' },
  { family: 'thermal-multispectral-camera', buses: ['csi', 'spi', 'uart'], implementation: 'deferred', validation: 'none' },
  { family: 'esc-telemetry', buses: ['uart', 'dshot', 'can'], implementation: 'deferred', validation: 'none' },
  { family: 'gripper-winch', buses: ['pwm', 'can'], implementation: 'deferred', validation: 'none' },
  { family: 'relay-light', buses: ['gpio', 'i2c'], implementation: 'deferred', validation: 'none' },
  { family: 'transponder', buses: ['uart', 'can'], implementation: 'deferred', validation: 'none' },
  { family: 'sampling-payload', buses: ['gpio', 'pwm', 'can'], implementation: 'deferred', validation: 'none' },
  { family: 'power-monitor', buses: ['power-monitor'], implementation: 'deferred', validation: 'none' },
] as const)
