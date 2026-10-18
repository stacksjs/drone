import { cli } from '@stacksjs/cli'
import SurfaceSimulate from '../../../app/Commands/SurfaceSimulate'
const app = cli('surface-test')
SurfaceSimulate(app)
await app.parse(process.argv)
