import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'
import { incidentRoles } from '../../resources/functions/drone/public-safety/access/types'

export default defineModel({
  name: 'PublicSafetyIncidentMember', table: 'public_safety_incident_members',
  traits: { useTimestamps: true }, dashboard: { enabled: false },
  indexes: [{ name: 'public_safety_incident_member_unique', columns: ['incident_id', 'user_id'], unique: true }],
  attributes: {
    incidentId: { required: true, fillable: true, foreignKey: { table: 'public_safety_incidents', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    userId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    role: { required: true, fillable: true, validation: { rule: schema.enum(incidentRoles) } },
    active: { required: true, fillable: true, default: true, validation: { rule: schema.boolean() } },
    version: { required: true, fillable: true, default: 1, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    grantedBy: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    revokedBy: { required: false, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
  },
} as const)
