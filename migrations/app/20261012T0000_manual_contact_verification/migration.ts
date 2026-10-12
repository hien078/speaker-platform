#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/656449ac938c323b314580d07a280025d021e4694f6158f1b086ec2edf7b0fec/contract';
import startContract from '../../snapshots/656449ac938c323b314580d07a280025d021e4694f6158f1b086ec2edf7b0fec/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ec3fc69d14672b04241aed700fe7abb6014c2308ca51188228b1b05ed28142e5/contract';
import endContract from '../../snapshots/ec3fc69d14672b04241aed700fe7abb6014c2308ca51188228b1b05ed28142e5/contract.json' with { type: 'json' };
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
        table: 'ManualContactVerification',
        columns: [
          col('channel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
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
          col('method', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requestedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('requestedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('requested'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('targetHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ManualContactVerification_channel_check_d360ded9',
            "\"channel\" IN ('email', 'phone')",
          ),
          checkExpression(
            'ManualContactVerification_method_check_57528128',
            "\"method\" IN ('phone_call', 'in_person', 'video_call', 'other')",
          ),
          checkExpression(
            'ManualContactVerification_status_check_0bb6ca3a',
            "\"status\" IN ('requested', 'approved', 'rejected', 'cancelled', 'expired')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_decidedById_idx_8194d55f',
        columns: ['decidedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_requestedById_idx_f9a56c66',
        columns: ['requestedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_status_requestedAt_idx_27ce3e29',
        columns: ['status', 'requestedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_userId_channel_idx_c26a97e9',
        columns: ['userId', 'channel'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'ManualContactVerification_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ManualContactVerification',
        index: 'manual_contact_one_requested_5d8a2516',
        columns: ['userId', 'channel'],
        extras: { where: '("status" = \'requested\')', unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ManualContactVerification',
        foreignKey: {
          name: 'ManualContactVerification_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ManualContactVerification',
        foreignKey: {
          name: 'ManualContactVerification_requestedById_fkey',
          columns: ['requestedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ManualContactVerification',
        foreignKey: {
          name: 'ManualContactVerification_decidedById_fkey',
          columns: ['decidedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
