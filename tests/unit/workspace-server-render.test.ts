import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { log, registerTransport } from '@stacksjs/logging'
import { report } from '@stacksjs/logging/runtime'
import type { LogRecord } from '@stacksjs/logging'
import { renderTemplate } from '@stacksjs/stx'

for (const [page, heading] of [
  ['diagnostics', 'Inspect what happened.'],
  ['volumes', 'Stockpile volume analysis'],
  ['application', 'Prescribed application'],
] as const) {
  test(`${page} server render keeps client analysis out of the native error reporter`, async () => {
    const root = resolve(import.meta.dir, '../..')
    const directory = await mkdtemp(join(tmpdir(), 'drone-workspace-render-'))
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'report')
    const errors: LogRecord[] = []
    const detach = registerTransport({ name: 'workspace-render-observer', level: 'error', log: record => { errors.push(record) } })
    try {
      // Use the actual production global, with an observing transport rather than a mock reporter.
      Object.defineProperty(globalThis, 'report', { configurable: true, writable: true, value: report })
      report(new Error('workspace-render-observer-control'))
      await log.flush()
      expect(errors).toHaveLength(1)
      errors.length = 0
      const html = await renderTemplate(join(root, 'resources/views', `${page}.stx`), {
        injectCSS: true,
        options: {
          root: join(root, 'resources'),
          componentsDir: join(root, 'resources/components'),
          composablesDir: join(directory, 'composables'),
          storesDir: join(directory, 'stores'),
          stateDir: join(directory, 'stx'),
          envFile: false,
          strict: { enabled: true, bundlerFallback: 'error' },
        },
      })
      await log.flush()
      expect(html).toContain(heading)
      expect(errors).toEqual([])
    }
    finally {
      detach()
      if (previous) Object.defineProperty(globalThis, 'report', previous)
      else Reflect.deleteProperty(globalThis, 'report')
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}
