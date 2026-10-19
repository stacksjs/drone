import { createTypedRouter, route } from '@stacksjs/router'
import DroneStatus from '../app/Actions/DroneStatus'
import CameraState from '../app/Actions/CameraState'
import CameraCommand from '../app/Actions/CameraCommand'

import PublicSafetyIncidentCreate from '../app/Actions/PublicSafetyIncidentCreate'
import PublicSafetyIncidentRead from '../app/Actions/PublicSafetyIncidentRead'
import PublicSafetyIncidentMembership from '../app/Actions/PublicSafetyIncidentMembership'
import PublicSafetyIncidentClose from '../app/Actions/PublicSafetyIncidentClose'
import PublicSafetyIncidentAudit from '../app/Actions/PublicSafetyIncidentAudit'
import PublicSafetySourceRegister from '../app/Actions/PublicSafetySourceRegister'
import PublicSafetySourceRead from '../app/Actions/PublicSafetySourceRead'
import PublicSafetySourceList from '../app/Actions/PublicSafetySourceList'
import PublicSafetyObservationCreate from '../app/Actions/PublicSafetyObservationCreate'
import PublicSafetyObservationRead from '../app/Actions/PublicSafetyObservationRead'
import PublicSafetyObservationList from '../app/Actions/PublicSafetyObservationList'
import PublicSafetyReviewAppend from '../app/Actions/PublicSafetyReviewAppend'
import PublicSafetyReviewList from '../app/Actions/PublicSafetyReviewList'
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
route.post('/public-safety/incidents/{incident}/sources', PublicSafetySourceRegister).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/sources/{digest}', PublicSafetySourceRead).middleware('auth')
route.get('/public-safety/incidents/{incident}/sources', PublicSafetySourceList).middleware('auth')
route.post('/public-safety/incidents/{incident}/observations', PublicSafetyObservationCreate).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/observations/{observation}', PublicSafetyObservationRead).middleware('auth')
route.get('/public-safety/incidents/{incident}/observations', PublicSafetyObservationList).middleware('auth')
route.post('/public-safety/incidents/{incident}/observations/{observation}/reviews', PublicSafetyReviewAppend).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/observations/{observation}/reviews', PublicSafetyReviewList).middleware('auth')
