#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1350a596e5d91729f817bb862f0dc4089c7fbb2676d3fc96fe8889a8fce8760e/contract';
import endContract from '../../snapshots/1350a596e5d91729f817bb862f0dc4089c7fbb2676d3fc96fe8889a8fce8760e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract';
import startContract from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract.json' with { type: 'json' };
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
        table: 'ProductEvent',
        columns: [
          col('actorPseudonym', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('conversationId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isInternal', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('listingId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('metadata', 'json', { codecRef: { codecId: 'pg/json@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('occurredAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('productModelId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('provinceCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('pseudonymKeyVersion', 'text', {
            notNull: true,
            default: lit('1'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('schemaVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('searchSessionId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sessionPseudonym', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'SearchAlias',
        columns: [
          col('alias', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('brandId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('productModelId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('target', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('SearchAlias_target_check_4dbecc53', "\"target\" IN ('brand', 'model')"),
          checkExpression(
            'search_alias_target_ids_8672a4d4',
            '((target = \'brand\' AND "brandId" IS NOT NULL AND "productModelId" IS NULL) OR (target = \'model\' AND "productModelId" IS NOT NULL AND "brandId" IS NULL))',
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('locationSource', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('searchTextNormalized', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_locationSource_check_4813b5cf',
        expression: "\"locationSource\" IN ('seller_declared', 'legacy_mapped', 'unresolved')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'SearchAlias',
        constraint: 'SearchAlias_alias_target_key',
        columns: ['alias', 'target'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Listing',
        index: 'listing_search_text_search_90e9bd00',
        expression: 'to_tsvector(\'simple\', "searchTextNormalized")',
        extras: { type: 'gin' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'ProductEvent',
        index: 'ProductEvent_actorPseudonym_occurredAt_idx_2b704e82',
        columns: ['actorPseudonym', 'occurredAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ProductEvent',
        index: 'ProductEvent_conversationId_idx_669215a6',
        columns: ['conversationId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ProductEvent',
        index: 'ProductEvent_listingId_idx_953decda',
        columns: ['listingId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ProductEvent',
        index: 'ProductEvent_name_occurredAt_idx_212a4f4e',
        columns: ['name', 'occurredAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ProductEvent',
        index: 'ProductEvent_searchSessionId_idx_2ab99a8a',
        columns: ['searchSessionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'SearchAlias',
        index: 'SearchAlias_alias_idx_0aae2ef5',
        columns: ['alias'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'SearchAlias',
        index: 'SearchAlias_brandId_idx_02e95397',
        columns: ['brandId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'SearchAlias',
        index: 'SearchAlias_productModelId_idx_5c4e2620',
        columns: ['productModelId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'SearchAlias',
        foreignKey: {
          name: 'SearchAlias_brandId_fkey',
          columns: ['brandId'],
          references: { schema: 'public', table: 'Brand', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'SearchAlias',
        foreignKey: {
          name: 'SearchAlias_productModelId_fkey',
          columns: ['productModelId'],
          references: { schema: 'public', table: 'ProductModel', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
