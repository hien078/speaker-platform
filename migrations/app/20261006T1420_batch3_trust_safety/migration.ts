#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0ed42b4563bdd21ef0c4fd0af28cd764edfcf464e419207721dbb15fd12b8e64/contract';
import startContract from '../../snapshots/0ed42b4563bdd21ef0c4fd0af28cd764edfcf464e419207721dbb15fd12b8e64/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/dbd12d36f72ca512419a7f4c170d8d798cdc03cb9b9919f4ff35119134814df1/contract';
import endContract from '../../snapshots/dbd12d36f72ca512419a7f4c170d8d798cdc03cb9b9919f4ff35119134814df1/contract.json' with { type: 'json' };
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
      this.dropCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_status_check_cc925b6c',
      }),
      this.createTable({
        schema: 'public',
        table: 'AbuseReport',
        columns: [
          col('caseId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reasonCode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reporterId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('targetId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'AbuseReport_reasonCode_check_4123daed',
            "\"reasonCode\" IN ('suspected_scam', 'harassment', 'spam', 'counterfeit_claim', 'misleading_listing', 'prohibited_content', 'unsafe_behavior', 'identity_impersonation', 'other')",
          ),
          checkExpression(
            'AbuseReport_targetType_check_7d298aee',
            "\"targetType\" IN ('listing', 'user', 'message')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'Appeal',
        columns: [
          col('appellantId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('caseId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('closedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('state', 'text', {
            notNull: true,
            default: lit('submitted'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('statement', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('Appeal_state_check_7c0e4b2e', "\"state\" IN ('submitted', 'closed')"),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'ModerationAction',
        columns: [
          col('actionType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('actorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('caseId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reasonCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('targetId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('targetType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'ModerationCase',
        columns: [
          col('assignedModeratorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('priority', 'text', {
            notNull: true,
            default: lit('normal'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('reasonCategory', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('state', 'text', {
            notNull: true,
            default: lit('open'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('targetId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ModerationCase_priority_check_f81d8d9b',
            "\"priority\" IN ('low', 'normal', 'high')",
          ),
          checkExpression(
            'ModerationCase_reasonCategory_check_db40a994',
            "\"reasonCategory\" IN ('suspected_scam', 'harassment', 'spam', 'counterfeit_claim', 'misleading_listing', 'prohibited_content', 'unsafe_behavior', 'identity_impersonation', 'other')",
          ),
          checkExpression(
            'ModerationCase_state_check_a778d74c',
            "\"state\" IN ('open', 'triaged', 'investigating', 'actioned', 'dismissed', 'appealed', 'closed')",
          ),
          checkExpression(
            'ModerationCase_targetType_check_7d298aee',
            "\"targetType\" IN ('listing', 'user', 'message')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'ModerationEvidence',
        columns: [
          col('capturedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('caseId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('classification', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('relevantSnapshot', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('reporterUserId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sourceResourceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sourceResourceType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subjectUserId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'UserBlock',
        columns: [
          col('blockedId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('blockerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'UserSuspension',
        columns: [
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('liftReasonCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('liftedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('liftedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reasonCode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('suspendedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('suspendedById', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'UserSuspension_status_check_826da613',
            "\"status\" IN ('active', 'lifted')",
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'AbuseReport',
        constraint: 'AbuseReport_caseId_reporterId_key',
        columns: ['caseId', 'reporterId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Appeal',
        constraint: 'Appeal_caseId_key',
        columns: ['caseId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_status_check_505de324',
        expression:
          "\"status\" IN ('draft', 'pending', 'approved', 'rejected', 'hidden', 'sold', 'removed')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'UserBlock',
        constraint: 'UserBlock_blockerId_blockedId_key',
        columns: ['blockerId', 'blockedId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AbuseReport',
        index: 'AbuseReport_caseId_createdAt_idx_18fcd752',
        columns: ['caseId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AbuseReport',
        index: 'AbuseReport_caseId_idx_f7093793',
        columns: ['caseId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AbuseReport',
        index: 'AbuseReport_reporterId_createdAt_idx_468b5f4f',
        columns: ['reporterId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AbuseReport',
        index: 'AbuseReport_reporterId_idx_aa245831',
        columns: ['reporterId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AbuseReport',
        index: 'AbuseReport_targetType_targetId_idx_7a5ee9cb',
        columns: ['targetType', 'targetId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Appeal',
        index: 'Appeal_appellantId_idx_ae4cf735',
        columns: ['appellantId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationAction',
        index: 'ModerationAction_actorId_createdAt_idx_0e9f1adf',
        columns: ['actorId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationAction',
        index: 'ModerationAction_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationAction',
        index: 'ModerationAction_caseId_createdAt_idx_18fcd752',
        columns: ['caseId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationAction',
        index: 'ModerationAction_caseId_idx_f7093793',
        columns: ['caseId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationAction',
        index: 'ModerationAction_targetType_targetId_createdAt_idx_e37b8716',
        columns: ['targetType', 'targetId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationCase',
        index: 'ModerationCase_assignedModeratorId_idx_19bc61ea',
        columns: ['assignedModeratorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationCase',
        index: 'ModerationCase_state_updatedAt_idx_f9692f3e',
        columns: ['state', 'updatedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationCase',
        index: 'ModerationCase_targetType_targetId_idx_7a5ee9cb',
        columns: ['targetType', 'targetId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationCase',
        index: 'moderation_case_one_active_per_target_reason_7f3ba3cd',
        columns: ['targetType', 'targetId', 'reasonCategory'],
        extras: { where: "(state IN ('open', 'triaged', 'investigating'))", unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationEvidence',
        index: 'ModerationEvidence_caseId_capturedAt_idx_0525a671',
        columns: ['caseId', 'capturedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationEvidence',
        index: 'ModerationEvidence_caseId_idx_f7093793',
        columns: ['caseId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationEvidence',
        index: 'ModerationEvidence_reporterUserId_idx_24dc5c40',
        columns: ['reporterUserId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationEvidence',
        index: 'ModerationEvidence_subjectUserId_idx_60714ffd',
        columns: ['subjectUserId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ModerationEvidence',
        index: 'moderation_evidence_source_idx_d7306d73',
        columns: ['sourceResourceType', 'sourceResourceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserBlock',
        index: 'UserBlock_blockedId_idx_e3047657',
        columns: ['blockedId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserBlock',
        index: 'UserBlock_blockerId_idx_a25bd35c',
        columns: ['blockerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSuspension',
        index: 'UserSuspension_liftedById_idx_3b725051',
        columns: ['liftedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSuspension',
        index: 'UserSuspension_status_suspendedAt_idx_67dc6dbd',
        columns: ['status', 'suspendedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSuspension',
        index: 'UserSuspension_suspendedById_idx_441458ac',
        columns: ['suspendedById'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSuspension',
        index: 'UserSuspension_userId_status_idx_e4a128ba',
        columns: ['userId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserSuspension',
        index: 'user_suspension_one_active_c770076c',
        columns: ['userId'],
        extras: { where: "(status = 'active')", unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AbuseReport',
        foreignKey: {
          name: 'AbuseReport_reporterId_fkey',
          columns: ['reporterId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AbuseReport',
        foreignKey: {
          name: 'AbuseReport_caseId_fkey',
          columns: ['caseId'],
          references: { schema: 'public', table: 'ModerationCase', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Appeal',
        foreignKey: {
          name: 'Appeal_caseId_fkey',
          columns: ['caseId'],
          references: { schema: 'public', table: 'ModerationCase', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Appeal',
        foreignKey: {
          name: 'Appeal_appellantId_fkey',
          columns: ['appellantId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationAction',
        foreignKey: {
          name: 'ModerationAction_caseId_fkey',
          columns: ['caseId'],
          references: { schema: 'public', table: 'ModerationCase', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationAction',
        foreignKey: {
          name: 'ModerationAction_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationCase',
        foreignKey: {
          name: 'ModerationCase_assignedModeratorId_fkey',
          columns: ['assignedModeratorId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationEvidence',
        foreignKey: {
          name: 'ModerationEvidence_caseId_fkey',
          columns: ['caseId'],
          references: { schema: 'public', table: 'ModerationCase', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationEvidence',
        foreignKey: {
          name: 'ModerationEvidence_subjectUserId_fkey',
          columns: ['subjectUserId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ModerationEvidence',
        foreignKey: {
          name: 'ModerationEvidence_reporterUserId_fkey',
          columns: ['reporterUserId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserBlock',
        foreignKey: {
          name: 'UserBlock_blockerId_fkey',
          columns: ['blockerId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserBlock',
        foreignKey: {
          name: 'UserBlock_blockedId_fkey',
          columns: ['blockedId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserSuspension',
        foreignKey: {
          name: 'UserSuspension_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserSuspension',
        foreignKey: {
          name: 'UserSuspension_suspendedById_fkey',
          columns: ['suspendedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserSuspension',
        foreignKey: {
          name: 'UserSuspension_liftedById_fkey',
          columns: ['liftedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
