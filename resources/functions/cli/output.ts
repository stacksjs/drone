import type { Writable } from 'node:stream'
import { format } from 'node:util'

// Mirrors the native Stacks CLI async output helpers until the next dependency release.
// Source: storage/framework/core/cli/src/output.ts in stacksjs/stacks.
/** Print to stdout, awaiting completion even when a pipe applies backpressure. */
export async function printAsync(...args: unknown[]): Promise<void> {
  await writeLineAsync(process.stdout, format(...args))
}

/** Print to stderr, awaiting completion without changing the exit code. */
export async function printErrorAsync(...args: unknown[]): Promise<void> {
  await writeLineAsync(process.stderr, format(...args))
}

function writeLineAsync(stream: Writable, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      stream.off('error', onError)
      reject(error)
    }
    stream.once('error', onError)
    try {
      stream.write(`${message}\n`, 'utf8', (error) => {
        if (error) {
          // Writable emits the error after calling its write callback. Keep
          // this write's listener through that notification, then remove it.
          setImmediate(() => stream.off('error', onError))
          reject(error)
        }
        else {
          stream.off('error', onError)
          resolve()
        }
      })
    }
    catch (error) {
      stream.off('error', onError)
      reject(error)
    }
  })
}
