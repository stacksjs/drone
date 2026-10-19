import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Append-only human custody history. No worker or impersonated system account exists in this tracer. */
export default defineModel({
  name: 'PublicSafetyRetentionEvent', table: 'public_safety_retention_events',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_retention_event_sequence_unique', columns: ['scope_id', 'sequence'], unique: true },
    { name: 'public_safety_retention_request_unique', columns: ['scope_id', 'request_id'], unique: true },
  ],
  attributes: {
    scopeId: { required: true, fillable: true, foreignKey: { table: 'public_safety_retention_scopes', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    sequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    incidentVersion: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    action: { required: true, fillable: true, validation: { rule: schema.enum(['enrolled', 'hold-reviewed', 'member-revoked']) } },
    requestId: { required: true, fillable: true, validation: { rule: schema.string().min(36).max(36) } },
    requestDigest: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(64).max(64) } },
    actorUserId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    atIso: { required: true, fillable: true, validation: { rule: schema.string().min(24).max(24) } },
    decision: { required: false, fillable: true, validation: { rule: schema.enum(['retain', 'release']) } },
    caseReference: { required: false, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(128) } },
    reviewDueAt: { required: false, fillable: true, validation: { rule: schema.string().min(24).max(24) } },
    targetUserId: { required: false, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
  },
} as const)
