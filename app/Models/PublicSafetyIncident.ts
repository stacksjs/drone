import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** System-owned incident scope. Access is exclusively through authenticated incident services. */
export default defineModel({
  name: 'PublicSafetyIncident', table: 'public_safety_incidents',
  traits: { useTimestamps: true }, dashboard: { enabled: false },
  indexes: [{ name: 'public_safety_incident_key_unique', columns: ['incident_key'], unique: true }],
  attributes: {
    incidentKey: { required: true, fillable: true, validation: { rule: schema.string().max(64) } },
    version: { required: true, fillable: true, default: 1, validation: { rule: schema.number().integer().min(1).max(2147483647) } },
    coordinatorId: { required: true, fillable: true, foreignKey: { table: 'users', column: 'id', onDelete: 'restrict' }, validation: { rule: schema.number().integer().min(1) } },
    status: { required: true, fillable: true, validation: { rule: schema.enum(['active', 'closed', 'purged']) } },
    purpose: { required: false, nullable: true, fillable: true, validation: { rule: schema.enum(['search-and-rescue', 'fire-observation', 'disaster-assessment', 'lawful-police-observation']) } },
    revision: { required: false, nullable: true, fillable: true, validation: { rule: schema.string().max(64) } },
    configJson: { required: false, nullable: true, fillable: true, hidden: true, validation: { rule: schema.string().max(262144) } },
    retainUntil: { required: true, fillable: true, validation: { rule: schema.string().max(24) } },
  },
} as const)
