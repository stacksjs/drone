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

import PayloadsBench from '../app/Commands/PayloadsBench'
import PayloadsCapture from '../app/Commands/PayloadsCapture'

import DiagnosticsRecord from '../app/Commands/DiagnosticsRecord'
import DiagnosticsReplay from '../app/Commands/DiagnosticsReplay'
import DiagnosticsInspect from '../app/Commands/DiagnosticsInspect'
import DiagnosticsExport from '../app/Commands/DiagnosticsExport'

import MissionsSimulate from '../app/Commands/MissionsSimulate'
import MissionsValidate from '../app/Commands/MissionsValidate'
import MissionsReplay from '../app/Commands/MissionsReplay'

import NavigationSimulate from '../app/Commands/NavigationSimulate'

import AntennaBench from '../app/Commands/AntennaBench'
import AirSimulate from '../app/Commands/AirSimulate'
import GroundSimulate from '../app/Commands/GroundSimulate'
import SurfaceSimulate from '../app/Commands/SurfaceSimulate'
import SubseaSimulate from '../app/Commands/SubseaSimulate'
import VisionValidate from '../app/Commands/VisionValidate'
import VisionSimulate from '../app/Commands/VisionSimulate'
import MappingPlan from '../app/Commands/MappingPlan'
import MappingSimulate from '../app/Commands/MappingSimulate'
import VolumesDemo from '../app/Commands/VolumesDemo'
import VolumesProcess from '../app/Commands/VolumesProcess'
import VolumesImport from '../app/Commands/VolumesImport'
import InspectionPlan from '../app/Commands/InspectionPlan'
import InspectionSimulate from '../app/Commands/InspectionSimulate'
import InspectionReview from '../app/Commands/InspectionReview'
import InspectionCompare from '../app/Commands/InspectionCompare'

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
PayloadsBench(app)
PayloadsCapture(app)
DiagnosticsRecord(app)
DiagnosticsReplay(app)
DiagnosticsInspect(app)
DiagnosticsExport(app)
MissionsSimulate(app)
MissionsValidate(app)
MissionsReplay(app)
NavigationSimulate(app)
AntennaBench(app)
AirSimulate(app)
GroundSimulate(app)
SurfaceSimulate(app)
SubseaSimulate(app)
VisionValidate(app)
VisionSimulate(app)
MappingPlan(app)
MappingSimulate(app)
VolumesDemo(app)
VolumesProcess(app)
VolumesImport(app)
InspectionPlan(app)
InspectionSimulate(app)
InspectionReview(app)
InspectionCompare(app)
app.help()
app.version('0.1.0')
try { await app.parse(process.argv) }
catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
