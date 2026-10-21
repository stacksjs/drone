import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'

try { console.log(JSON.stringify(enrollRuntimeTrust(JSON.parse(process.argv[2] ?? '')))) }
catch { console.error('Trust enrollment rejected'); process.exitCode = 1 }
