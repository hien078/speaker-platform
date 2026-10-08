#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/1350a596e5d91729f817bb862f0dc4089c7fbb2676d3fc96fe8889a8fce8760e/contract';
import startContract from '../../snapshots/1350a596e5d91729f817bb862f0dc4089c7fbb2676d3fc96fe8889a8fce8760e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/292dd3fbd5f0e8543fea2e3e04297f170f53408ac8b348c7c7f3cd4868741277/contract';
import endContract from '../../snapshots/292dd3fbd5f0e8543fea2e3e04297f170f53408ac8b348c7c7f3cd4868741277/contract.json' with { type: 'json' };
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
        table: 'Deal',
        columns: [
          col('agreedPrice', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('buyerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('buyerOutcomeAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('cancellationReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('conversationId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('fulfillmentMethod', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('listingId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sellerId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sellerOutcomeAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('open'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'Deal_fulfillmentMethod_check_247caea4',
            "\"fulfillmentMethod\" IN ('meetup', 'seller_delivery', 'carrier', 'other')",
          ),
          checkExpression(
            'Deal_status_check_871208bd',
            "\"status\" IN ('open', 'completed', 'cancelled', 'no_deal')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'DealStatusHistory',
        columns: [
          col('actorId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('dealId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'DealStatusHistory_status_check_871208bd',
            "\"status\" IN ('open', 'completed', 'cancelled', 'no_deal')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_buyerId_createdAt_idx_7547b79f',
        columns: ['buyerId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_buyerId_idx_80be0de9',
        columns: ['buyerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_conversationId_idx_669215a6',
        columns: ['conversationId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_listingId_idx_953decda',
        columns: ['listingId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_sellerId_createdAt_idx_a21eaac1',
        columns: ['sellerId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_sellerId_idx_d71255f2',
        columns: ['sellerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'Deal_status_updatedAt_idx_29f913bb',
        columns: ['status', 'updatedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Deal',
        index: 'deal_one_open_per_listing_buyer_77dfd57d',
        columns: ['listingId', 'buyerId'],
        extras: { where: "(status = 'open')", unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'DealStatusHistory',
        index: 'DealStatusHistory_actorId_createdAt_idx_0e9f1adf',
        columns: ['actorId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'DealStatusHistory',
        index: 'DealStatusHistory_actorId_idx_a58f6b4b',
        columns: ['actorId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'DealStatusHistory',
        index: 'DealStatusHistory_dealId_createdAt_idx_33a673d8',
        columns: ['dealId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'DealStatusHistory',
        index: 'DealStatusHistory_dealId_idx_3e3b3068',
        columns: ['dealId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Deal',
        foreignKey: {
          name: 'Deal_listingId_fkey',
          columns: ['listingId'],
          references: { schema: 'public', table: 'Listing', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Deal',
        foreignKey: {
          name: 'Deal_buyerId_fkey',
          columns: ['buyerId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Deal',
        foreignKey: {
          name: 'Deal_sellerId_fkey',
          columns: ['sellerId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'DealStatusHistory',
        foreignKey: {
          name: 'DealStatusHistory_dealId_fkey',
          columns: ['dealId'],
          references: { schema: 'public', table: 'Deal', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'DealStatusHistory',
        foreignKey: {
          name: 'DealStatusHistory_actorId_fkey',
          columns: ['actorId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
