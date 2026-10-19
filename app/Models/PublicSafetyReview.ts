import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'
import { reviewDispositions } from '../../resources/functions/drone/public-safety/access/record-types'

export default defineModel({
  name: 'PublicSafetyReview', table: 'public_safety_reviews',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false },
  dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_review_sequence_unique', columns: ['observation_id', 'created_sequence'], unique: true },
  ],
  attributes: {
    observationId: { required: true, fillable: true, foreignKey: { table: 'public_safety_observations', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    previousReviewId: { required: false, fillable: true, foreignKey: { table: 'public_safety_reviews', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    disposition: { required: true, fillable: true, validation: { rule: schema.enum(reviewDispositions) } },
    note: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().min(1).max(2048) } },
    actorId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(Number.MAX_SAFE_INTEGER) } },
    reviewedAtIso: { required: true, fillable: true, validation: { rule: schema.string().min(1).max(24) } },
    createdSequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
  },
} as const)
