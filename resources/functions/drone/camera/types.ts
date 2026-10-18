export interface ImageBox { x: number, y: number, width: number, height: number }
export interface Detection { label: 'person', confidence: number, box: ImageBox }
export interface CameraFrame {
  sequence: number
  /** Both timestamps use the consumer's local monotonic clock domain. */
  capturedAtMs: number
  receivedAtMs: number
  detections: Detection[]
}
export interface Candidate extends Detection { id: string }
export interface VisualLock {
  id: string
  box: ImageBox
  confidence: number
  lastSeenAtMs: number
  confirmations: number
}
export interface TrackingSnapshot {
  state: 'idle' | 'tracking' | 'lost'
  reason: string
  sequence: number | null
  candidates: Candidate[]
  selected: VisualLock | null
  confirmed: boolean
  /** Image-space observation only. Never a metric position or navigation target. */
  observation: { horizontalError: number, verticalError: number } | null
}
export interface CameraSnapshot {
  sessionId: string | null
  source: 'stopped' | 'replay' | 'imx500'
  status: 'stopped' | 'starting' | 'running' | 'error'
  error: string | null
  tracking: TrackingSnapshot
  image: string | null
  physicalFlightEnabled: false
}
