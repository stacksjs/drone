import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PublicSafetyObservation', table: 'public_safety_observations',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_observation_sequence', columns: ['source_id', 'created_sequence'] },
  ],
  attributes: {
    sourceId: { required: true, fillable: true, foreignKey: { table: 'public_safety_sources', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    captureId: { required: true, fillable: true, validation: { rule: schema.string().min(1).max(64) } },
    modality: { required: true, fillable: true, validation: { rule: schema.enum(['visible', 'thermal']) } },
    pixelX: { required: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(9007199254740991) } },
    pixelY: { required: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(9007199254740991) } },
    note: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(2048) } },
    uncertaintyNote: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(1024) } },
    actorId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    observedAtIso: { required: true, fillable: true, validation: { rule: schema.string().min(1).max(24) } },
    createdSequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
  },
} as const)
