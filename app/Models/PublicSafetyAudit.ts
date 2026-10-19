import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Append-only through the domain API. No automatic row API, copied imagery or credential values. */
export default defineModel({
  name: 'PublicSafetyAudit', table: 'public_safety_audits',
  traits: { useTimestamps: true }, dashboard: { enabled: false },
  indexes: [{ name: 'public_safety_audit_sequence_unique', columns: ['incident_id', 'sequence'], unique: true }],
  attributes: {
    incidentId: { required: true, fillable: true, foreignKey: { table: 'public_safety_incidents', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    sequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    actorId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    action: { required: true, fillable: true, validation: { rule: schema.enum(['created', 'member-granted', 'member-revoked', 'closed']) } },
    targetUserId: { required: false, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    atIso: { required: true, fillable: true, validation: { rule: schema.string().max(24) } },
    detailsJson: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(2048) } },
  },
} as const)
