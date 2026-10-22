/** An independently owned OS peer, so runtime pause/buffering behavior cannot consume test traffic. */
export async function createPressurePeer(telemetry: Uint8Array) {
  const fixture = new URL('./tcp-pressure-peer.py', import.meta.url).pathname
  const child = Bun.spawn(['python3', fixture, Buffer.from(telemetry).toString('hex')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let port: number | undefined, receiveBufferBytes = 0, receivedBytes = 0, failure: Error | undefined, stderr = ''
  async function consume(stream: ReadableStream<Uint8Array>, limit: number, receive: (text: string) => void) {
    const reader = stream.getReader(), decoder = new TextDecoder()
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > limit) throw new Error('Native pressure peer output exceeded its byte bound')
        receive(decoder.decode(chunk.value, { stream: true }))
      }
    }
    catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); child.kill('SIGKILL') }
    finally { reader.releaseLock() }
  }
  let partial = ''
  const stdout = consume(child.stdout, 131072, text => {
    partial += text
    while (partial.includes('\n')) {
      const end = partial.indexOf('\n'), line = partial.slice(0, end); partial = partial.slice(end + 1)
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native pressure peer observation')
      if ('type' in value && value.type === 'ready' && 'port' in value && typeof value.port === 'number'
        && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
        && 'receiveBufferBytes' in value && typeof value.receiveBufferBytes === 'number'
        && Number.isInteger(value.receiveBufferBytes) && value.receiveBufferBytes > 0 && value.receiveBufferBytes <= 16384) {
        port = value.port; receiveBufferBytes = value.receiveBufferBytes
      }
      else if ('type' in value && (value.type === 'received' || value.type === 'closed') && 'bytes' in value && typeof value.bytes === 'number'
        && Number.isInteger(value.bytes) && value.bytes >= receivedBytes && value.bytes <= 33554432) receivedBytes = value.bytes
      else throw new Error('Invalid native pressure peer observation')
    }
  })
  const errors = consume(child.stderr, 65536, text => { stderr += text })
  async function close() {
    let endError: unknown
    try { child.stdin.end() }
    catch (error) { endError = error; child.kill('SIGTERM') }
    const guard = setTimeout(() => child.kill('SIGKILL'), 1000)
    try {
      const exit = await child.exited
      await Promise.all([stdout, errors])
      if (endError) throw new Error('Native pressure peer input close failed', { cause: endError })
      if (failure) throw failure
      if (exit !== 0 || partial || stderr) throw new Error(`Native pressure peer failed: exit ${exit}, ${stderr}`)
    }
    finally { clearTimeout(guard) }
  }
  try {
    const deadline = performance.now() + 5000
    while (port === undefined) {
      if (failure) throw failure
      if (child.exitCode !== null || performance.now() >= deadline) throw new Error('Native pressure peer did not establish its listener')
      await Bun.sleep(5)
    }
    return { port, receiveBufferBytes,
      receivedBytes() { if (failure) throw failure; return receivedBytes },
      resume() {
        child.stdin.write('resume\n')
        void Promise.resolve(child.stdin.flush()).catch(error => { failure ??= error instanceof Error ? error : new Error(String(error)) })
      }, close }
  }
  catch (error) {
    try { await close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native pressure peer setup and cleanup failed') }
    throw error
  }
}
