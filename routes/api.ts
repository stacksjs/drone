import { createTypedRouter, route } from '@stacksjs/router'
import DroneStatus from '../app/Actions/DroneStatus'
import CameraState from '../app/Actions/CameraState'
import CameraCommand from '../app/Actions/CameraCommand'

import PublicSafetyIncidentCreate from '../app/Actions/PublicSafetyIncidentCreate'
import PublicSafetyIncidentRead from '../app/Actions/PublicSafetyIncidentRead'
import PublicSafetyIncidentMembership from '../app/Actions/PublicSafetyIncidentMembership'
import PublicSafetyIncidentClose from '../app/Actions/PublicSafetyIncidentClose'
import PublicSafetyIncidentAudit from '../app/Actions/PublicSafetyIncidentAudit'
import { incidentHttpBoundary } from '../resources/functions/drone/public-safety/access/http'
import { incidentDataExposureBoundary } from '../resources/functions/drone/public-safety/access/exposure'

route.use(incidentDataExposureBoundary)
route.use(incidentHttpBoundary)

export const api = createTypedRouter().get('/drone/capabilities', DroneStatus)
  .get('/camera/state', CameraState)
// Authenticate before reading the bounded wire body. The typed builder has no parseBody option.
route.post('/camera/command', CameraCommand).parseBody(false)
export type AppRoutes = typeof api

route.post('/public-safety/incidents', PublicSafetyIncidentCreate).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}', PublicSafetyIncidentRead).middleware('auth')
route.put('/public-safety/incidents/{incident}/members', PublicSafetyIncidentMembership).middleware('auth').parseBody(false)
route.post('/public-safety/incidents/{incident}/close', PublicSafetyIncidentClose).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/audit', PublicSafetyIncidentAudit).middleware('auth')
