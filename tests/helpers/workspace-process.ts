import assert from 'node:assert/strict'
import { basename } from 'node:path'

/** Own the isolated fixture process group, including its driver and browser. */
export function spawnWorkspaceFixture(command: string[], directory: string, env: NodeJS.ProcessEnv) {
  assert(process.platform !== 'win32', 'Workspace browser qualification requires POSIX process groups')
  assert(basename(directory).startsWith('drone-incident-access-'))
  const child = Bun.spawn(command, { cwd: directory, env, detached: true, stdout: 'pipe', stderr: 'pipe' })
  const signal = (value: NodeJS.Signals | 0) => {
    try { process.kill(-child.pid, value); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  }
  let stopping: Promise<void> | undefined
  return {
    child,
    stop() {
      return stopping ??= (async () => {
        if (signal(0)) signal('SIGTERM')
        let end = Date.now() + 3000
        while (signal(0) && Date.now() < end) await Bun.sleep(25)
        if (signal(0)) signal('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(1000)])
        end = Date.now() + 2000
        while (signal(0) && Date.now() < end) await Bun.sleep(25)
        assert(!signal(0), 'Owned fixture processes must exit before disposable files are removed')
      })()
    },
  }
}
