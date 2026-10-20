import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

// Fixture-only native session schema, never installed as an application model or API.
export default defineModel({
  name: 'Session', table: 'sessions', primaryKey: 'id', autoIncrement: false,
  traits: { useApi: false, useTimestamps: false },
  attributes: {
    id: { required: true, validation: { rule: schema.string() } },
    userId: { required: true, validation: { rule: schema.number().integer() } },
    ipAddress: { validation: { rule: schema.string().optional() } },
    userAgent: { validation: { rule: schema.string().optional() } },
    payload: { required: true, validation: { rule: schema.string() } },
    lastActivity: { required: true, validation: { rule: schema.number().integer() } },
    expiresAt: { required: true, validation: { rule: schema.string() } },
  },
})
