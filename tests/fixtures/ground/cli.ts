import { cli } from '@stacksjs/cli'
import GroundSimulate from '../../../app/Commands/GroundSimulate'

const app = cli('ground-test')
GroundSimulate(app)
await app.parse(process.argv)
