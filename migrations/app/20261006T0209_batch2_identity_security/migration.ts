#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0ed42b4563bdd21ef0c4fd0af28cd764edfcf464e419207721dbb15fd12b8e64/contract';
import endContract from '../../snapshots/0ed42b4563bdd21ef0c4fd0af28cd764edfcf464e419207721dbb15fd12b8e64/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/7a6d2852c760b1265b539fc21c77fe33c6b83827ec12bc79495ecf5281c3cdf4/contract';
import startContract from '../../snapshots/7a6d2852c760b1265b539fc21c77fe33c6b83827ec12bc79495ecf5281c3cdf4/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';
import postgres from '@prisma/orm-postgres/runtime';

// Query builder từ endContract (module scope) — cho data transform bên dưới.
// postgres() lazy: KHÔNG mở connection khi module load (migrations.md § Fill a placeholder).
const { sql: db, contract } = postgres<End>({ contractJson: endContract });

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'AdminMfa',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('totpConfirmedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('totpSecretEnc', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'AdminRecoveryCode',
        columns: [
          col('codeHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('mfaId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('usedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'AuditEvent',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('actorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('detail', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ipHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('policyVersion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resourceId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resourceType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sessionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('subjectId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'BetaCohortMembership',
        columns: [
          col('acceptedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('cohort', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('expiresAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('invitedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('invitedBy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('invited'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'BetaCohortMembership_cohort_check_008d7f38',
            "\"cohort\" IN ('internal', 'founding_seller', 'private_beta_buyer')",
          ),
          checkExpression(
            'BetaCohortMembership_status_check_c34e9cfa',
            "\"status\" IN ('invited', 'active', 'suspended', 'exited')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'OtpCode',
        columns: [
          col('attempts', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('channel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('codeHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('consumedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('purpose', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('target', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('OtpCode_channel_check_d360ded9', "\"channel\" IN ('email', 'phone')"),
          checkExpression(
            'OtpCode_purpose_check_e0deb69d',
            "\"purpose\" IN ('email_verification', 'phone_verification', 'password_recovery')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'PolicyAcceptance',
        columns: [
          col('acceptedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('policyKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('policyVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'SellerVerification',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('method', 'text', {
            notNull: true,
            default: lit('operations_review'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('policyVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reasonCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reviewedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('reviewerId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('submittedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'SellerVerification_method_check_b1d86172',
            '"method" IN (\'operations_review\')',
          ),
          checkExpression(
            'SellerVerification_status_check_152ba99e',
            "\"status\" IN ('not_started', 'pending', 'verified', 'rejected', 'needs_review', 'revoked')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'UserSession',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isAdmin', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('lastSeenAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('revokedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('revokedReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('steppedUpAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userAgent', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('adminRole', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('emailVerifiedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('phoneVerifiedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('sellerOperatingProvinceCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('sellerType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'AdminMfa',
        constraint: 'AdminMfa_userId_key',
        columns: ['userId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'BetaCohortMembership',
        constraint: 'BetaCohortMembership_userId_cohort_key',
        columns: ['userId', 'cohort'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'PolicyAcceptance',
        constraint: 'PolicyAcceptance_userId_policyKey_policyVersion_key',
        columns: ['userId', 'policyKey', 'policyVersion'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'SellerVerification',
        constraint: 'SellerVerification_userId_key',
        columns: ['userId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'User',
        constraint: 'User_adminRole_check_207534e1',
        expression:
          "\"adminRole\" IN ('super_admin', 'operations_admin', 'moderator', 'support', 'analyst')",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'User',
        constraint: 'User_sellerType_check_acee2066',
        expression: "\"sellerType\" IN ('individual', 'business')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'UserSession',
        constraint: 'UserSession_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AdminRecoveryCode',
        index: 'AdminRecoveryCode_mfaId_idx_ee734963',
        columns: ['mfaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AdminRecoveryCode',
        index: 'AdminRecoveryCode_mfaId_usedAt_idx_80410bb6',
        columns: ['mfaId', 'usedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditEvent',
        index: 'AuditEvent_action_createdAt_idx_a6d20b4b',
        columns: ['action', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditEvent',
        index: 'AuditEvent_actorId_createdAt_idx_0e9f1adf',
        columns: ['actorId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditEvent',
        index: 'AuditEvent_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditEvent',
        index: 'AuditEvent_subjectId_createdAt_idx_7aaee74d',
        columns: ['subjectId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditEvent',
        index: 'AuditEvent_subjectId_idx_84df2a1d',
        columns: ['subjectId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaCohortMembership',
        index: 'BetaCohortMembership_cohort_status_idx_7712340b',
        columns: ['cohort', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaCohortMembership',
        index: 'BetaCohortMembership_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'OtpCode',
        index: 'OtpCode_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'OtpCode',
        index: 'OtpCode_target_purpose_createdAt_idx_d7415d45',
        columns: ['target', 'purpose', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'OtpCode',
        index: 'OtpCode_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'OtpCode',
        index: 'OtpCode_userId_purpose_createdAt_idx_8932d08c',
        columns: ['userId', 'purpose', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PolicyAcceptance',
        index: 'PolicyAcceptance_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PolicyAcceptance',
        index: 'PolicyAcceptance_userId_policyKey_idx_82b249a3',
        columns: ['userId', 'policyKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'SellerVerification',
        index: 'SellerVerification_status_updatedAt_idx_29f913bb',
        columns: ['status', 'updatedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSession',
        index: 'UserSession_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSession',
        index: 'UserSession_userId_createdAt_idx_f726f04a',
        columns: ['userId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSession',
        index: 'UserSession_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AdminMfa',
        foreignKey: {
          name: 'AdminMfa_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AdminRecoveryCode',
        foreignKey: {
          name: 'AdminRecoveryCode_mfaId_fkey',
          columns: ['mfaId'],
          references: { schema: 'public', table: 'AdminMfa', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AuditEvent',
        foreignKey: {
          name: 'AuditEvent_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AuditEvent',
        foreignKey: {
          name: 'AuditEvent_subjectId_fkey',
          columns: ['subjectId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'BetaCohortMembership',
        foreignKey: {
          name: 'BetaCohortMembership_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'OtpCode',
        foreignKey: {
          name: 'OtpCode_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PolicyAcceptance',
        foreignKey: {
          name: 'PolicyAcceptance_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'SellerVerification',
        foreignKey: {
          name: 'SellerVerification_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserSession',
        foreignKey: {
          name: 'UserSession_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      // Backfill legacy admin → adminRole (spec §8.5 — mapping CÓ CHỦ ĐÍCH của
      // các tài khoản broad-admin hiện có; sau Batch 2 `role` chỉ còn display,
      // `adminRole` là nguồn authorization duy nhất). Idempotent: predicate
      // role='admin' AND adminRole IS NULL — chạy lại migration là no-op.
      // check: rowset (EXISTS precheck / NOT EXISTS postcheck) — KHÔNG dùng
      // aggregate (migrations.md § Fill a placeholder).
      //
      // `updatedAt` set CHUẬN ĐỘNG dạng string: trigger temporal.updatedAtString()
      // sinh param Date — Date bị sortKeys (canonicalizeJson khi hash migration)
      // phá thành {} → migrationHash ghi lúc self-emit ≠ hash tính lại từ
      // ops.json (MIGRATION.CONTRACT_SPACE_VIOLATION khi db migrate). Giá trị
      // string tường minh thắng trigger, giữ nguyên semantics (bump updatedAt),
      // và JSON-round-trip ổn định.
      this.dataTransform(contract, 'backfill-admin-role', {
        check: () =>
          db.public.User.select('id')
            .where((f, fns) => fns.and(fns.eq(f.role, 'admin'), fns.eq(f.adminRole, null)))
            .limit(1),
        run: () =>
          db.public.User.update({
            adminRole: 'super_admin',
            updatedAt: new Date().toISOString(),
          })
            .where((f, fns) => fns.and(fns.eq(f.role, 'admin'), fns.eq(f.adminRole, null))),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
