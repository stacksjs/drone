import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private managed dataset metadata. No deletion or background execution. */
export default defineModel({
  name: 'PublicSafetyManagedArtifactFile', table: 'public_safety_managed_artifact_files',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_managed_file_path_unique', columns: ['artifact_id', 'relative_path'], unique: true },
    { name: 'public_safety_managed_file_ordinal_unique', columns: ['artifact_id', 'ordinal'], unique: true },
  ],
  attributes: {
    artifactId: { required: true, fillable: true, foreignKey: { table: 'public_safety_managed_artifacts', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    ordinal: { required: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(770) } },
    role: { required: true, fillable: true, validation: { rule: schema.enum(['recording', 'visible', 'thermal', 'support', 'readme', 'manifest']) } },
    captureId: { required: false, fillable: true, validation: { rule: schema.string().max(64) } },
    relativePath: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(240) } },
    mimeType: { required: true, fillable: true, validation: { rule: schema.string().max(64) } },
    plannedBytes: { required: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(33554432) } },
    sha256: { required: true, fillable: true, validation: { rule: schema.string().max(64) } },
    identityJson: { required: false, fillable: true, hidden: true, validation: { rule: schema.string().max(16384) } },
    observedBytes: { required: false, fillable: true, validation: { rule: schema.number().integer().min(0).max(33554433) } },
    observedSha256: { required: false, fillable: true, validation: { rule: schema.string().max(64) } },
  },
} as const)
