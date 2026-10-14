#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/cbad7facbb336295afa263cfe89705814f6bd77b88fdeac1379de38ff6cdcef3/contract';
import endContract from '../../snapshots/cbad7facbb336295afa263cfe89705814f6bd77b88fdeac1379de38ff6cdcef3/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ec3fc69d14672b04241aed700fe7abb6014c2308ca51188228b1b05ed28142e5/contract';
import startContract from '../../snapshots/ec3fc69d14672b04241aed700fe7abb6014c2308ca51188228b1b05ed28142e5/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        columns: [
          col('checkListingTitle', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('checkProvince', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('checkRegistrationMonth', 'bool', {
            notNull: true,
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('checksPassed', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('consumedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('decidedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('decidedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('phoneHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('phoneVerifiedAtSnapshot', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('requestedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('requestedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resetTokenExpiresAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('resetTokenHash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('requested'),
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
            'AccountRecoveryRequest_status_check_8162b213',
            "\"status\" IN ('requested', 'approved', 'rejected', 'cancelled', 'expired', 'consumed')",
          ),
          checkExpression(
            'account_recovery_checks_range_827d8d2e',
            '"checksPassed" BETWEEN 2 AND 3',
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'AccountRecoveryRequest_decidedById_idx_8194d55f',
        columns: ['decidedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'AccountRecoveryRequest_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'AccountRecoveryRequest_requestedById_idx_f9a56c66',
        columns: ['requestedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'AccountRecoveryRequest_status_requestedAt_idx_27ce3e29',
        columns: ['status', 'requestedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'AccountRecoveryRequest_userId_status_idx_e4a128ba',
        columns: ['userId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        index: 'account_recovery_one_open_b136b151',
        columns: ['userId'],
        extras: {
          where: '("status" = \'requested\' OR ("status" = \'approved\' AND "consumedAt" IS NULL))',
          unique: true,
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        foreignKey: {
          name: 'AccountRecoveryRequest_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        foreignKey: {
          name: 'AccountRecoveryRequest_requestedById_fkey',
          columns: ['requestedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AccountRecoveryRequest',
        foreignKey: {
          name: 'AccountRecoveryRequest_decidedById_fkey',
          columns: ['decidedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
