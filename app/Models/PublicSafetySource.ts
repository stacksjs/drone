import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PublicSafetySource', table: 'public_safety_sources',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_source_digest_unique', columns: ['incident_id', 'digest'], unique: true },
    { name: 'public_safety_source_sequence', columns: ['incident_id', 'created_sequence'] },
  ],
  attributes: {
    incidentId: { required: true, fillable: true, foreignKey: { table: 'public_safety_incidents', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    digest: { required: true, fillable: true, validation: { rule: schema.string().min(1).max(64) } },
    byteLength: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(16777216) } },
    canonicalJson: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(16777216) } },
    replayProfile: { required: true, fillable: true, validation: { rule: schema.enum(['owned-public-safety-collection-v1']) } },
    evidence: { required: true, fillable: true, validation: { rule: schema.enum(['owned-public-safety-physics-simulation']) } },
    uploaderId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    uploadedAtIso: { required: true, fillable: true, validation: { rule: schema.string().min(1).max(24) } },
    createdSequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
  },
} as const)
