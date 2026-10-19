import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Private accepted local purge state. No automatic API, search, seed or scheduler. */
export default defineModel({
  name: 'PublicSafetyPurgeItem', table: 'public_safety_purge_items',
  traits: { useTimestamps: true, useApi: false, useSearch: false, useSeeder: false }, dashboard: { enabled: false },
  indexes: [
    { name: 'public_safety_purge_item_ordinal_unique', columns: ['purge_id', 'ordinal'], unique: true },
    { name: 'public_safety_purge_item_state', columns: ['purge_id', 'state', 'ordinal'], unique: false },
  ],
  attributes: {
    purgeId: { required: true, fillable: true, foreignKey: { table: 'public_safety_purges', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    ordinal: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    kind: { required: true, fillable: true, validation: { rule: schema.enum(['artifact', 'file', 'directory', 'db-row']) } },
    parentItemId: { required: false, nullable: true, fillable: true, foreignKey: { table: 'public_safety_purge_items', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    artifactOrdinal: { required: false, nullable: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    sourceTable: { required: false, nullable: true, fillable: true, validation: { rule: schema.enum(['managed-artifact', 'review', 'observation', 'source', 'audit', 'noncustody-membership', 'incident-payload']) } },
    sourceRowId: { required: false, nullable: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    plannedJson: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(4194304) } },
    identityJson: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(16384) } },
    aliasJson: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(16384) } },
    armJson: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(262144) } },
    plannedBytes: { required: false, nullable: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(33554432) } },
    observedBytes: { required: false, nullable: true, fillable: true, validation: { rule: schema.number().integer().min(0).max(33554432) } },
    plannedSha256: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(64) } },
    observedSha256: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(64) } },
    version: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    generation: { required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    operationNonce: { required: true, fillable: true, hidden: true, validation: { rule: schema.string().max(36) } },
    state: { required: true, fillable: true, validation: { rule: schema.enum(['planned', 'armed', 'verified-absent', 'row-removed', 'blocked']) } },
    resultCode: { required: false, nullable: true, fillable: true, validation: { rule: schema.enum(['observed-unlinked', 'absence-reconciled', 'row-removed', 'no-preparation-observed', 'executor-disabled', 'ownership-uncertain', 'inspection-unavailable', 'identity-changed', 'unexpected-entry', 'unexpected-link', 'missing-unarmed', 'io-failed', 'sql-failed', 'inventory-changed', 'foreign-reference', 'capacity-exceeded']) } },
    armedAtIso: { required: false, nullable: true, fillable: true, validation: { rule: schema.string().max(24) } },
    verifiedAtIso: { required: false, nullable: true, fillable: true, validation: { rule: schema.string().max(24) } },
  },
} as const)
