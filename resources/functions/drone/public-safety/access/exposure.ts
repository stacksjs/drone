/** Generic dashboard/model administration is outside this app's incident-scoped API.
 * Keep this boundary even when a deployment explicitly mounts framework bundles.
 * It does not replace the native authentication and membership checks on incident routes.
 */
export async function incidentDataExposureBoundary(request: Request, next: () => Promise<Response | null> | Response | null) {
  let path = new URL(request.url).pathname
  try { path = decodeURIComponent(path).toLowerCase() }
  catch { /* Malformed escapes cannot match a supported native literal route. */ }
  const reserved = ['/api/dashboard', '/models', '/dashboard']
  if (reserved.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return Response.json({ error: 'Not Found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie' } })
  return next()
}
