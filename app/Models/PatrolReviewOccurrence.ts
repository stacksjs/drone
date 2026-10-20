import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private authenticated simulation-intent ledger. No generic API or vehicle authority. */
export default defineModel({
  name: 'PatrolReviewOccurrence', table: 'patrol_review_occurrences', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: false, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'patrol_review_occurrence_due_unique', columns: ['schedule_id', 'due_utc_ms'], unique: true },
    { name: 'patrol_review_occurrence_review_unique', columns: ['schedule_id', 'review_request_id'], unique: true },
    { name: 'patrol_review_occurrence_consume_unique', columns: ['schedule_id', 'consume_request_id'], unique: true },
  ],
  attributes: {
    id: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    scheduleId: { required: true, fillable: false, hidden: true, foreignKey: { table: 'patrol_review_schedules', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    dueUtcMs: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1767225600000).max(1767225660000) } },
    scopeDigest: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(64).max(64).matches(/^[a-f0-9]{64}$/) } },
    state: { required: true, fillable: false, hidden: true, validation: { rule: schema.enum(['awaiting-review', 'approved', 'denied', 'consumed']) } },
    decision: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.enum(['approve', 'deny']) } },
    reviewerId: { required: false, nullable: true, fillable: false, hidden: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    reviewerTokenId: { required: false, nullable: true, fillable: false, hidden: true, foreignKey: false, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    reviewedAtIso: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().min(24).max(24).matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
    expiresAtIso: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().min(24).max(24).matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
    reviewRequestId: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().min(36).max(36).matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) } },
    consumedAtIso: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().min(24).max(24).matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
    consumeRequestId: { required: false, nullable: true, fillable: false, hidden: true, validation: { rule: schema.string().min(36).max(36).matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) } },
  },
} as const)
