// Server-private response identity metadata. This is never a header or a serialized capability.
const deadlines = new WeakMap<Response, number>()

export function associateManagedDownload(response: Response, deadline: number): Response {
  deadlines.set(response, deadline)
  return response
}
export function managedDownloadDeadline(response: Response): number | undefined {
  return deadlines.get(response)
}
