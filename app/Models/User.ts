import { extendModel } from '@stacksjs/orm'
import User from '../../storage/framework/defaults/app/Models/User'

/** Preserve native credential validation, hashing, hiding and auth traits without a generic account API. */
export default extendModel(User, {
  traits: { useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false, highlight: false },
})
