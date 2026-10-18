import { cli } from '@stacksjs/cli'
import AirSimulate from '../../../app/Commands/AirSimulate'
const app = cli('air-test')
AirSimulate(app)
await app.parse(process.argv)
