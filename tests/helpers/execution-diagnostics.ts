type DiagnosticStatus = 'pending' | 'fulfilled' | 'rejected'
export interface ExecutionDiagnosticParts {
  server: unknown
  dom: unknown
  serverStatus: DiagnosticStatus
  domStatus: DiagnosticStatus
}

/** Preserve each completed observation within the existing one-second diagnostic budget. */
export async function settleExecutionDiagnostics(server: Promise<unknown>, dom: Promise<unknown>): Promise<ExecutionDiagnosticParts> {
  const parts: ExecutionDiagnosticParts = { server: { available: false }, dom: null, serverStatus: 'pending', domStatus: 'pending' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })
  const tasks = [
    server.then(value => { parts.server = value; parts.serverStatus = 'fulfilled' }, () => { parts.serverStatus = 'rejected' }),
    dom.then(value => { parts.dom = value; parts.domStatus = 'fulfilled' }, () => { parts.domStatus = 'rejected' }),
  ]
  try {
    await Promise.race([Promise.all(tasks), timeout])
    // Late responses may update the private accumulator, never this returned observation.
    return { ...parts }
  }
  finally { clearTimeout(timer) }
}
