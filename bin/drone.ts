#!/usr/bin/env bun
import { cli } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import RuntimeBuild from '../app/Commands/RuntimeBuild'
import RuntimeBench from '../app/Commands/RuntimeBench'
import RuntimeInspect from '../app/Commands/RuntimeInspect'

const app = cli('drone')
RuntimeBuild(app)
RuntimeBench(app)
RuntimeInspect(app)
app.help()
app.version('0.1.0')
try { await app.parse(process.argv) }
catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
