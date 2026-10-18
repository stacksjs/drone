import { createTypedRouter } from '@stacksjs/router'
import DroneStatus from '../app/Actions/DroneStatus'

export const api = createTypedRouter().get('/drone/capabilities', DroneStatus)
export type AppRoutes = typeof api
