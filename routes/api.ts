import { createTypedRouter, route } from '@stacksjs/router'
import DroneStatus from '../app/Actions/DroneStatus'
import CameraState from '../app/Actions/CameraState'
import CameraCommand from '../app/Actions/CameraCommand'

export const api = createTypedRouter().get('/drone/capabilities', DroneStatus)
  .get('/camera/state', CameraState)
// Authenticate before reading the bounded wire body. The typed builder has no parseBody option.
route.post('/camera/command', CameraCommand).parseBody(false)
export type AppRoutes = typeof api
