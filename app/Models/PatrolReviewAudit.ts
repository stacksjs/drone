import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private authenticated simulation-intent ledger. No generic API or vehicle authority. */
export default defineModel({
  name: 'PatrolReviewAudit', table: 'patrol_review_audits', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: false, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'patrol_review_audit_sequence_unique', columns: ['schedule_id', 'sequence'], unique: true },
    { name: 'patrol_review_audit_request_unique', columns: ['schedule_id', 'request_id'], unique: true },
  ],
  attributes: {
    id: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    scheduleId: { required: true, fillable: false, hidden: true, foreignKey: { table: 'patrol_review_schedules', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    sequence: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(5) } },
    actorId: { required: true, fillable: false, hidden: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    tokenId: { required: true, fillable: false, hidden: true, foreignKey: false, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    action: { required: true, fillable: false, hidden: true, validation: { rule: schema.enum(['created', 'approved', 'denied', 'consumed']) } },
    requestId: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(36).max(36).matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) } },
    requestDigest: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(64).max(64).matches(/^[a-f0-9]{64}$/) } },
    atIso: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(24).max(24).matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
    detailsJson: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(1).max(512) } },
  },
} as const)
