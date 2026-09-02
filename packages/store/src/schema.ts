// SQLite schema for the gateway control plane (ADR-0007).
// Single source of truth for the persistent tables; migrations are generated
// with drizzle-kit (see drizzle.config.ts) and applied in SqliteStore.open().
//
// Live state (node sockets, heartbeats, leases, the console-seat mutex) stays
// in process memory — see ADR-0007 §3/§4. The `seats` table is a durable
// audit helper ("who last held which machine"), NOT the mutex.

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // Role: platform-admin | tenant-admin | user
  authHash: text('auth_hash').notNull(),
})

export const machines = sqliteTable('machines', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  nodeKeyHash: text('node_key_hash').notNull(),
  status: text('status').notNull(), // MachineStatus: pending | approved | revoked
  dshVersion: text('dsh_version'),
  configRev: integer('config_rev').notNull().default(0),
  lastHeartbeatAt: text('last_heartbeat_at'),
  createdAt: text('created_at').notNull(),
})

export const assignments = sqliteTable(
  'assignments',
  {
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.userId] })],
)

export const pairingCodes = sqliteTable('pairing_codes', {
  codeHash: text('code_hash').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  machineId: text('machine_id'),
  expiresAt: text('expires_at').notNull(),
  consumedBy: text('consumed_by'),
})

// One row per machine = its current (or last) console-seat holder (audit helper).
export const seats = sqliteTable('seats', {
  machineId: text('machine_id')
    .primaryKey()
    .references(() => machines.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sessionRef: text('session_ref').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  ttlMs: integer('ttl_ms').notNull(),
})

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: text('ts').notNull(),
  actor: text('actor').notNull(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  machineId: text('machine_id'),
  action: text('action').notNull(),
  result: text('result').notNull(), // ok | denied | error
  detail: text('detail'),
})
