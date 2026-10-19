import { createTypedRouter, route } from '@stacksjs/router'
import DroneStatus from '../app/Actions/DroneStatus'
import CameraState from '../app/Actions/CameraState'
import CameraCommand from '../app/Actions/CameraCommand'

import PublicSafetyIncidentCreate from '../app/Actions/PublicSafetyIncidentCreate'
import PublicSafetyIncidentRead from '../app/Actions/PublicSafetyIncidentRead'
import PublicSafetyIncidentMembership from '../app/Actions/PublicSafetyIncidentMembership'
import PublicSafetyIncidentClose from '../app/Actions/PublicSafetyIncidentClose'
import PublicSafetyIncidentAudit from '../app/Actions/PublicSafetyIncidentAudit'
import PublicSafetyHandoverDesk from '../app/Actions/PublicSafetyHandoverDesk'
import PublicSafetyHandoverOffer from '../app/Actions/PublicSafetyHandoverOffer'
import PublicSafetyHandoverDecision from '../app/Actions/PublicSafetyHandoverDecision'
import PublicSafetyWorkspace from '../app/Actions/PublicSafetyWorkspace'
import PublicSafetyWorkspaceEvents from '../app/Actions/PublicSafetyWorkspaceEvents'
import PublicSafetySourceRegister from '../app/Actions/PublicSafetySourceRegister'
import PublicSafetySourceRead from '../app/Actions/PublicSafetySourceRead'
import PublicSafetySourceList from '../app/Actions/PublicSafetySourceList'
import PublicSafetyObservationCreate from '../app/Actions/PublicSafetyObservationCreate'
import PublicSafetyObservationRead from '../app/Actions/PublicSafetyObservationRead'
import PublicSafetyObservationList from '../app/Actions/PublicSafetyObservationList'
import PublicSafetyReviewAppend from '../app/Actions/PublicSafetyReviewAppend'
import PublicSafetyReviewList from '../app/Actions/PublicSafetyReviewList'
import PublicSafetyRetentionPreview from '../app/Actions/PublicSafetyRetentionPreview'
import PublicSafetyRetentionEnroll from '../app/Actions/PublicSafetyRetentionEnroll'
import PublicSafetyRetentionRead from '../app/Actions/PublicSafetyRetentionRead'
import PublicSafetyRetentionHoldReview from '../app/Actions/PublicSafetyRetentionHoldReview'
import PublicSafetyRetentionEvents from '../app/Actions/PublicSafetyRetentionEvents'
import PublicSafetyCustodyMemberRevoke from '../app/Actions/PublicSafetyCustodyMemberRevoke'
import PublicSafetyManagedCreate from '../app/Actions/PublicSafetyManagedCreate'
import PublicSafetyManagedList from '../app/Actions/PublicSafetyManagedList'
import PublicSafetyManagedRead from '../app/Actions/PublicSafetyManagedRead'
import PublicSafetyManagedFile from '../app/Actions/PublicSafetyManagedFile'
import PublicSafetyManagedEvents from '../app/Actions/PublicSafetyManagedEvents'
import PublicSafetyManagedReconcile from '../app/Actions/PublicSafetyManagedReconcile'
import PublicSafetyPurgePreview from '../app/Actions/PublicSafetyPurgePreview'
import PublicSafetyPurgeAccept from '../app/Actions/PublicSafetyPurgeAccept'
import PublicSafetyPurgeRead from '../app/Actions/PublicSafetyPurgeRead'
import PublicSafetyPurgeEvents from '../app/Actions/PublicSafetyPurgeEvents'
import PublicSafetyPurgeRetry from '../app/Actions/PublicSafetyPurgeRetry'
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
route.match(['GET', 'HEAD'], '/public-safety/incidents/{incident}/workspace', PublicSafetyWorkspace).middleware('auth').parseBody(false)
route.match(['GET', 'HEAD'], '/public-safety/incidents/{incident}/workspace/events', PublicSafetyWorkspaceEvents).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/handover', PublicSafetyHandoverDesk).middleware('auth')
route.post('/public-safety/incidents/{incident}/handover/offer', PublicSafetyHandoverOffer).middleware('auth').parseBody(false)
route.post('/public-safety/incidents/{incident}/handover/decision', PublicSafetyHandoverDecision).middleware('auth').parseBody(false)
route.post('/public-safety/incidents/{incident}/sources', PublicSafetySourceRegister).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/sources/{digest}', PublicSafetySourceRead).middleware('auth')
route.get('/public-safety/incidents/{incident}/sources', PublicSafetySourceList).middleware('auth')
route.post('/public-safety/incidents/{incident}/observations', PublicSafetyObservationCreate).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/observations/{observation}', PublicSafetyObservationRead).middleware('auth')
route.get('/public-safety/incidents/{incident}/observations', PublicSafetyObservationList).middleware('auth')
route.post('/public-safety/incidents/{incident}/observations/{observation}/reviews', PublicSafetyReviewAppend).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/observations/{observation}/reviews', PublicSafetyReviewList).middleware('auth')
route.get('/public-safety/incidents/{incident}/retention/preview', PublicSafetyRetentionPreview).middleware('auth')
route.post('/public-safety/incidents/{incident}/retention/enrollment', PublicSafetyRetentionEnroll).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/retention', PublicSafetyRetentionRead).middleware('auth')
route.post('/public-safety/incidents/{incident}/retention/hold', PublicSafetyRetentionHoldReview).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/retention/events', PublicSafetyRetentionEvents).middleware('auth')
route.post('/public-safety/incidents/{incident}/retention/revoke-member', PublicSafetyCustodyMemberRevoke).middleware('auth').parseBody(false)

route.post('/public-safety/incidents/{incident}/managed-artifacts', PublicSafetyManagedCreate).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/managed-artifacts', PublicSafetyManagedList).middleware('auth')
route.get('/public-safety/incidents/{incident}/managed-artifacts/{artifact}', PublicSafetyManagedRead).middleware('auth')
route.match(['GET', 'HEAD'], '/public-safety/incidents/{incident}/managed-artifacts/{artifact}/files/{file}', PublicSafetyManagedFile).middleware('auth')
route.get('/public-safety/incidents/{incident}/managed-artifacts/{artifact}/events', PublicSafetyManagedEvents).middleware('auth')
route.post('/public-safety/incidents/{incident}/managed-artifacts/{artifact}/reconcile', PublicSafetyManagedReconcile).middleware('auth').parseBody(false)

route.get('/public-safety/incidents/{incident}/retention/purge/preview', PublicSafetyPurgePreview).middleware('auth')
route.post('/public-safety/incidents/{incident}/retention/purge', PublicSafetyPurgeAccept).middleware('auth').parseBody(false)
route.get('/public-safety/incidents/{incident}/retention/purge/{purge}', PublicSafetyPurgeRead).middleware('auth')
route.get('/public-safety/incidents/{incident}/retention/purge/{purge}/events', PublicSafetyPurgeEvents).middleware('auth')
route.post('/public-safety/incidents/{incident}/retention/purge/{purge}/retry', PublicSafetyPurgeRetry).middleware('auth').parseBody(false)
