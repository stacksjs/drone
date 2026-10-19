import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Explicit policy enrollment only. This model schedules and performs no content deletion. */
export default defineModel({
  name: 'PublicSafetyRetentionScope', table: 'public_safety_retention_scopes',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [{ name: 'public_safety_retention_incident_unique', columns: ['incident_id'], unique: true }],
  attributes: {
    incidentId: { required: true, fillable: true, foreignKey: { table: 'public_safety_incidents', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    version: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    policyVersion: { required: true, fillable: true, validation: { rule: schema.enum(['local-managed-v1']) } },
    inventoryDigest: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(64).max(64) } },
    originalHold: { required: true, fillable: true, validation: { rule: schema.enum(['none', 'declared-review-required']) } },
    holdState: { required: true, fillable: true, validation: { rule: schema.enum(['none', 'pending-review', 'held', 'released']) } },
    caseReference: { required: false, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(128) } },
    reviewDueAt: { required: false, fillable: true, validation: { rule: schema.string().min(24).max(24) } },
    reviewerUserId: { required: false, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    reviewedAtIso: { required: false, fillable: true, validation: { rule: schema.string().min(24).max(24) } },
    enrolledByUserId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    enrolledAtIso: { required: true, fillable: true, validation: { rule: schema.string().min(24).max(24) } },
  },
} as const)
