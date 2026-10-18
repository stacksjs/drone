export type PayloadEvidence = 'fixture' | 'hardware'
export interface PayloadBusTiming { timeoutMs: number, maxTransferBytes: number, maxQueueDepth: 1 }
/** Contracts only. CSI camera acquisition is the first implementation; actuator bus writes are disabled. */
export type PayloadBusContract = PayloadBusTiming & (
  | { kind: 'csi', model: 'IMX500', connector: 'CAM/DISP0' | 'CAM/DISP1' | 'unspecified' }
  | { kind: 'spi', controller: number, chipSelect: number, mode: 0 | 1 | 2 | 3, clockHz: number }
  | { kind: 'i2c', controller: number, address7bit: number, clockHz: number }
  | { kind: 'uart', device: string, baud: number }
  | { kind: 'can' | 'dronecan' | 'cyphal', interface: string, bitrate: number, nodeId: number }
  | { kind: 'gpio', chip: number, line: number, inactiveLevel: 0 | 1 }
  | { kind: 'pwm', frequencyHz: number, minPulseUs: number, maxPulseUs: number, neutralPulseUs: number }
  | { kind: 'dshot', rateKbps: 150 | 300 | 600, neutralCommand: 0 }
  | { kind: 'power-monitor', transport: 'i2c' | 'can' | 'adc', maxVoltageV: number, maxCurrentA: number, calibrationId: string }
)
export interface CameraPayloadDescriptor {
  version: 1
  driver: 'replay-camera' | 'pi-ai-camera'
  deviceId: string
  sessionId: string
  bootId: string
  evidence: PayloadEvidence
  width: number
  height: number
  maxImageBytes: number
  sensorTimingCalibrated: false
  cameraExtrinsicsCalibrated: false
  physicalFlightEnabled: false
}
export interface PayloadCaptureCommand {
  version: 1
  sessionId: string
  bootId: string
  sequence: number
  issuedAtMs: number
  deadlineMs: number
}
export interface PayloadCaptureAck extends PayloadCaptureCommand {
  deviceId: string
  evidence: PayloadEvidence
  capturedAtMs: number
  acknowledgedAtMs: number
  clockUncertaintyMs: number
  timestampReference: 'sensor-first-row' | 'fixture'
  sensorTimingCalibrated: false
  exposureTimeUs: number
  width: number
  height: number
  jpeg: Uint8Array
}
export interface CameraPayloadAdapter {
  describe: () => CameraPayloadDescriptor
  capture: (command: PayloadCaptureCommand, signal?: AbortSignal) => Promise<PayloadCaptureAck>
  close: () => void
}
export const payloadLimits = Object.freeze({ maxImageBytes: 524288, packetCharacters: 750000, captureTimeoutMs: 2000, startupTimeoutMs: 15000, clockUncertaintyMs: 5, poseOffsetMs: 40, poseSamples: 128, poseWindowMs: 5000 })
export class PayloadCaptureError extends Error {
  constructor(public readonly code: 'invalid' | 'busy' | 'closed' | 'timeout' | 'cancelled' | 'device' | 'pose', message: string) { super(message); this.name = 'PayloadCaptureError' }
}
