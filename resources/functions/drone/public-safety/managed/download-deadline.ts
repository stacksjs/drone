import { associateIncidentDeadline, incidentDeadline } from '../access/deadline'

export function associateManagedDownload(response: Response, deadline: number): Response {
  return associateIncidentDeadline(response, deadline)
}
export function managedDownloadDeadline(response: Response): number | undefined {
  return incidentDeadline(response)
}
