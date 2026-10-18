#!/usr/bin/env bun
import { cli } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import RuntimeBuild from '../app/Commands/RuntimeBuild'
import RuntimeBench from '../app/Commands/RuntimeBench'
import RuntimeInspect from '../app/Commands/RuntimeInspect'
import SensorsReplay from '../app/Commands/SensorsReplay'
import SensorsInspect from '../app/Commands/SensorsInspect'
import EstimatorReplay from '../app/Commands/EstimatorReplay'
import DriversBench from '../app/Commands/DriversBench'
import AuthoritySimulate from '../app/Commands/AuthoritySimulate'
import ControlsSimulate from '../app/Commands/ControlsSimulate'

const app = cli('drone')
RuntimeBuild(app)
RuntimeBench(app)
RuntimeInspect(app)
SensorsReplay(app)
SensorsInspect(app)
EstimatorReplay(app)
ControlsSimulate(app)
AuthoritySimulate(app)
DriversBench(app)
app.help()
app.version('0.1.0')
try { await app.parse(process.argv) }
catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
