import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private managed dataset metadata. No deletion or background execution. */
export default defineModel({
  name: 'PublicSafetyManagedArtifactEvent', table: 'public_safety_managed_artifact_events',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_managed_event_sequence_unique', columns: ['artifact_id', 'sequence'], unique: true },
    { name: 'public_safety_managed_event_request_unique', columns: ['artifact_id', 'request_id', 'step'], unique: true },
  ],
  attributes: {
    artifactId: { required: true, fillable: true, foreignKey: { table: 'public_safety_managed_artifacts', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    sequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    incidentVersion: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    action: { required: true, fillable: true, validation: { rule: schema.enum(['intent-recorded', 'ownership-recorded', 'published', 'reconcile-claimed', 'reconciled-complete', 'interrupted', 'blocked']) } },
    actorUserId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    atIso: { required: true, fillable: true, validation: { rule: schema.string().max(24) } },
    requestId: { required: true, fillable: true, validation: { rule: schema.string().max(36) } },
    requestDigest: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(64) } },
    step: { required: true, fillable: true, validation: { rule: schema.enum(['intent', 'prepare', 'publish', 'claim', 'result']) } },
    outcomeCode: { required: false, fillable: true, validation: { rule: schema.string().max(32) } },
  },
} as const)
