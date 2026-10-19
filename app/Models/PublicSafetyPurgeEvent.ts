import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private accepted local purge state. No automatic API, search, seed or scheduler. */
export default defineModel({
  name: 'PublicSafetyPurgeEvent', table: 'public_safety_purge_events',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_purge_event_sequence_unique', columns: ['purge_id', 'sequence'], unique: true },
    { name: 'public_safety_purge_event_operation_unique', columns: ['purge_id', 'operation_id', 'step'], unique: true },
  ],
  attributes: {
    purgeId: { required: true, fillable: true, foreignKey: { table: 'public_safety_purges', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    sequence: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    incidentVersion: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    retentionVersion: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    operationId: { required: true, fillable: true, validation: { rule: schema.string().max(36) } },
    step: { required: true, fillable: true, validation: { rule: schema.enum(['accept', 'build', 'arm', 'result', 'db-batch', 'blocked', 'retry', 'minimize', 'complete', 'member-revoked']) } },
    actorKind: { required: true, fillable: true, validation: { rule: schema.enum(['human', 'system']) } },
    actorUserId: { required: false, nullable: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    systemActor: { required: false, nullable: true, fillable: true, validation: { rule: schema.enum(['public-safety-local-purge-v1']) } },
    requestDigest: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(64) } },
    atIso: { required: true, fillable: true, validation: { rule: schema.string().max(24) } },
    countsJson: { required: true, fillable: true, validation: { rule: schema.string().max(16384) } },
    outcomeCode: { required: false, nullable: true, fillable: true, validation: { rule: schema.enum(['executor-disabled', 'ownership-uncertain', 'inspection-unavailable', 'identity-changed', 'unexpected-entry', 'unexpected-link', 'missing-unarmed', 'io-failed', 'sql-failed', 'inventory-changed', 'foreign-reference', 'capacity-exceeded']) } },
  },
} as const)
