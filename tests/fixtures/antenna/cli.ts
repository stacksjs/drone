import { cli } from '@stacksjs/cli'
import AntennaBench from '../../../app/Commands/AntennaBench'

const app = cli('antenna-test')
AntennaBench(app)
await app.parse(process.argv)
