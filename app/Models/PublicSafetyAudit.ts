import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Append-only through the domain API. No automatic row API, copied imagery or credential values. */
export default defineModel({
  name: 'PublicSafetyAudit', table: 'public_safety_audits',
  traits: { useTimestamps: true }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_audit_sequence_unique', columns: ['incident_id', 'sequence'], unique: true },
    { name: 'public_safety_handover_step_unique', columns: ['incident_id', 'handover_key', 'handover_step'], unique: true },
    { name: 'public_safety_handover_request_unique', columns: ['incident_id', 'request_id'], unique: true },
    { name: 'public_safety_handover_assignment', columns: ['incident_id', 'actor_id', 'handover_assignment_version', 'action', 'sequence'] },
  ],
  attributes: {
    incidentId: { required: true, fillable: true, foreignKey: { table: 'public_safety_incidents', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    sequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    actorId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    action: { required: true, fillable: true, validation: { rule: schema.enum(['created', 'member-granted', 'member-revoked', 'closed', 'source-registered', 'observation-created', 'review-appended', 'handover-offered', 'handover-accepted', 'handover-declined', 'handover-canceled']) } },
    targetUserId: { required: false, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    atIso: { required: true, fillable: true, validation: { rule: schema.string().max(24) } },
    handoverKey: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().max(36) } },
    handoverStep: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.enum(['offer', 'terminal']) } },
    handoverAssignmentVersion: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    requestId: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().max(36) } },
    requestDigest: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().max(64) } },
    detailsJson: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(2048) } },
  },
} as const)
