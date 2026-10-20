import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private authenticated simulation-intent ledger. No generic API or vehicle authority. */
export default defineModel({
  name: 'PatrolReviewSchedule', table: 'patrol_review_schedules', primaryKey: 'id', autoIncrement: true,
  traits: { useTimestamps: false, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'patrol_review_schedule_owner_key_unique', columns: ['owner_user_id', 'schedule_key'], unique: true },
  ],
  attributes: {
    id: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    ownerUserId: { required: true, fillable: false, hidden: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    scheduleKey: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(1).max(40).matches(/^[a-z][a-z0-9-]{0,39}$/) } },
    revision: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(1) } },
    version: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1).max(5) } },
    profile: { required: true, fillable: false, hidden: true, validation: { rule: schema.enum(['nominal']) } },
    recurrenceProfile: { required: true, fillable: false, hidden: true, validation: { rule: schema.enum(['minute-zero-one-v1']) } },
    anchorUtcMs: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(1767225600000).max(1767225600000) } },
    horizonMs: { required: true, fillable: false, hidden: true, validation: { rule: schema.number().integer().min(180000).max(180000) } },
    inputJson: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(1).max(1024) } },
    bindingJson: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(1).max(1024) } },
    inputDigest: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(64).max(64).matches(/^[a-f0-9]{64}$/) } },
    bindingDigest: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(64).max(64).matches(/^[a-f0-9]{64}$/) } },
    createdAtIso: { required: true, fillable: false, hidden: true, validation: { rule: schema.string().min(24).max(24).matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } },
  },
} as const)
