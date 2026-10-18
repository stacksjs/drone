import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = resolve('storage/runtime-build/cli')
await mkdir(directory, { recursive: true })
const artifact = `${directory}/drone${process.platform === 'win32' ? '.exe' : ''}`
const result = await Bun.build({ entrypoints: ['bin/drone.ts'], target: 'bun', minify: true, compile: { outfile: artifact, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false } })
if (!result.success) throw new AggregateError(result.logs, 'Runtime CLI compilation failed')
console.log(artifact)
