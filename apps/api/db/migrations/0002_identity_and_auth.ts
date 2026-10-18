import { Knex } from 'knex';

/**
 * Phase 1 — identity, roles & authorization schema (see docs/architecture/03-data-model.md
 * §3.1 and 06-auth-and-authorization.md). No business data: just the authn/RBAC skeleton.
 *
 * Conventions (doc 03 §1): internal PKs are auto-increment integers; external references use
 * a separate ULID column. Timestamps are DATETIME(3) in UTC with ON UPDATE on mutable rows.
 *
 * Deviation from the illustrative DDL, anticipated by doc 03 ("types tuned during Phase 1"):
 * `auth_credential_otp.request_ip` is added to support per-IP OTP throttling (Phase 1).
 */

/** Fixed role codes (doc 06 §1). Reference data, seeded here so every environment has them. */
const ROLE_CODES = [
  'customer',
  'rider',
  'merchant_owner',
  'merchant_staff',
  'admin',
  'ops',
  'finance',
] as const;

export async function up(knex: Knex): Promise<void> {
  // Shared timestamp fragments (MySQL needs raw SQL for DATETIME(3) + ON UPDATE).
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('user', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.string('phone_e164', 20).notNullable().unique(); // +2547XXXXXXXX
    t.string('email', 255).nullable().unique();
    t.string('display_name', 120).nullable();
    t.string('password_hash', 255).nullable(); // null for OTP-only accounts
    t.enu('status', ['active', 'suspended', 'deleted']).notNullable().defaultTo('active');
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
  });

  await knex.schema.createTable('role', (t) => {
    t.specificType('id', 'SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT').primary();
    t.string('code', 40).notNullable().unique();
  });

  await knex.schema.createTable('user_role', (t) => {
    t.bigInteger('user_id').unsigned().notNullable();
    t.specificType('role_id', 'SMALLINT UNSIGNED').notNullable();
    t.primary(['user_id', 'role_id']);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.foreign('role_id').references('id').inTable('role').onDelete('RESTRICT');
  });

  await knex.schema.createTable('auth_credential_otp', (t) => {
    t.bigIncrements('id');
    t.string('phone_e164', 20).notNullable();
    t.string('code_hash', 255).notNullable(); // HMAC-SHA256 of the code, never plaintext
    t.enu('purpose', ['login', 'verify']).notNullable();
    t.specificType('attempts', 'TINYINT UNSIGNED').notNullable().defaultTo(0);
    t.specificType('request_ip', 'VARBINARY(16)').nullable();
    t.specificType('expires_at', 'DATETIME(3)').notNullable();
    t.specificType('consumed_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.index(['phone_e164', 'purpose'], 'idx_otp_phone_purpose');
    t.index(['phone_e164', 'created_at'], 'idx_otp_phone_created'); // per-phone throttle window
    t.index(['request_ip', 'created_at'], 'idx_otp_ip_created'); // per-IP throttle window
  });

  await knex.schema.createTable('refresh_token', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id').unsigned().notNullable();
    t.string('token_hash', 255).notNullable().unique(); // SHA-256 of the opaque token
    t.specificType('family_id', 'CHAR(26)').notNullable(); // rotation family for reuse detection
    t.specificType('expires_at', 'DATETIME(3)').notNullable();
    t.specificType('revoked_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.index(['user_id'], 'idx_refresh_user');
    t.index(['family_id'], 'idx_refresh_family');
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id');
    t.bigInteger('actor_user_id').unsigned().nullable();
    t.string('actor_role', 40).nullable();
    t.string('action', 80).notNullable(); // e.g. auth.otp.verify
    t.string('entity_type', 40).notNullable();
    t.bigInteger('entity_id').unsigned().nullable();
    t.specificType('ip', 'VARBINARY(16)').nullable();
    t.json('before_json').nullable();
    t.json('after_json').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    // Audit rows outlive their actor: null the FK instead of deleting the row.
    t.foreign('actor_user_id').references('id').inTable('user').onDelete('SET NULL');
    t.index(['entity_type', 'entity_id'], 'idx_audit_entity');
    t.index(['actor_user_id', 'created_at'], 'idx_audit_actor');
  });

  await knex('role').insert(ROLE_CODES.map((code) => ({ code })));
}

export async function down(knex: Knex): Promise<void> {
  // Drop children before parents (user_role/refresh_token/audit_log reference user & role).
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('refresh_token');
  await knex.schema.dropTableIfExists('auth_credential_otp');
  await knex.schema.dropTableIfExists('user_role');
  await knex.schema.dropTableIfExists('role');
  await knex.schema.dropTableIfExists('user');
}
