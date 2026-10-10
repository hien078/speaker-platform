#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/292dd3fbd5f0e8543fea2e3e04297f170f53408ac8b348c7c7f3cd4868741277/contract';
import startContract from '../../snapshots/292dd3fbd5f0e8543fea2e3e04297f170f53408ac8b348c7c7f3cd4868741277/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/656449ac938c323b314580d07a280025d021e4694f6158f1b086ec2edf7b0fec/contract';
import endContract from '../../snapshots/656449ac938c323b314580d07a280025d021e4694f6158f1b086ec2edf7b0fec/contract.json' with { type: 'json' };
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
        table: 'BetaInviteToken',
        columns: [
          col('candidateId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('channel', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
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
          col('issuedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('target', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'BetaInviteToken_channel_check_d360ded9',
            "\"channel\" IN ('email', 'phone')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        columns: [
          col('assignedOperatorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('contactChannel', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('contactReference', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('firstListingAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('invitedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('lastContactAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('qualityListingCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('registeredAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('prospect'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('targetCommunity', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('verifiedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'FoundingSellerCandidate_contactChannel_check_e3b33eb5',
            "\"contactChannel\" IN ('email', 'phone')",
          ),
          checkExpression(
            'FoundingSellerCandidate_status_check_fe58999c',
            "\"status\" IN ('prospect', 'invited', 'registered', 'verification_pending', 'verified', 'concierge_onboarding', 'first_listing', 'active_founding_seller', 'inactive', 'exited')",
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'BetaInviteToken',
        constraint: 'BetaInviteToken_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        constraint: 'FoundingSellerCandidate_userId_key',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaInviteToken',
        index: 'BetaInviteToken_candidateId_createdAt_idx_d01e196a',
        columns: ['candidateId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaInviteToken',
        index: 'BetaInviteToken_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaInviteToken',
        index: 'BetaInviteToken_issuedById_idx_c14f1329',
        columns: ['issuedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'BetaInviteToken',
        index: 'beta_invite_one_active_00182012',
        columns: ['candidateId'],
        extras: { where: '("consumedAt" IS NULL AND "revokedAt" IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        index: 'FoundingSellerCandidate_assignedOperatorId_idx_83d93e35',
        columns: ['assignedOperatorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        index: 'FoundingSellerCandidate_status_updatedAt_idx_29f913bb',
        columns: ['status', 'updatedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        index: 'FoundingSellerCandidate_targetCommunity_idx_dd20c9d8',
        columns: ['targetCommunity'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'BetaInviteToken',
        foreignKey: {
          name: 'BetaInviteToken_candidateId_fkey',
          columns: ['candidateId'],
          references: { schema: 'public', table: 'FoundingSellerCandidate', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'BetaInviteToken',
        foreignKey: {
          name: 'BetaInviteToken_issuedById_fkey',
          columns: ['issuedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        foreignKey: {
          name: 'FoundingSellerCandidate_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'FoundingSellerCandidate',
        foreignKey: {
          name: 'FoundingSellerCandidate_assignedOperatorId_fkey',
          columns: ['assignedOperatorId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
