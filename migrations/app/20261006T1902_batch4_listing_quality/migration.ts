#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/177b84a6eddeb3c7b93bdbe6273f0d5eb07c873e676107403880e0ec4d019231/contract';
import endContract from '../../snapshots/177b84a6eddeb3c7b93bdbe6273f0d5eb07c873e676107403880e0ec4d019231/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/dbd12d36f72ca512419a7f4c170d8d798cdc03cb9b9919f4ff35119134814df1/contract';
import startContract from '../../snapshots/dbd12d36f72ca512419a7f4c170d8d798cdc03cb9b9919f4ff35119134814df1/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_status_check_505de324',
      }),
      this.createTable({
        schema: 'public',
        table: 'ListingImageUpload',
        columns: [
          col('bytes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('height', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ownerUserId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storageKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('width', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('communeLevelCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('fulfillmentMethods', 'json', { codecRef: { codecId: 'pg/json@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('includedAccessories', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('inventoryContext', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('knownDefects', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('locationDisplayName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('provinceLevelCode', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('repairHistory', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'ListingImage',
        column: col('checklistSlot', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_inventoryContext_check_cbe03ac9',
        expression: "\"inventoryContext\" IN ('new', 'open_box', 'used')",
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'Listing',
        constraint: 'Listing_status_check_f81f49ae',
        expression:
          "\"status\" IN ('draft', 'pending', 'approved', 'rejected', 'hidden', 'sold', 'removed', 'archived')",
      }),
      this.addUnique({
        schema: 'public',
        table: 'ListingImageUpload',
        constraint: 'ListingImageUpload_storageKey_key',
        columns: ['storageKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ListingImageUpload',
        index: 'ListingImageUpload_ownerUserId_createdAt_idx_6e1bdf67',
        columns: ['ownerUserId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ListingImageUpload',
        index: 'ListingImageUpload_ownerUserId_idx_f93ae154',
        columns: ['ownerUserId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ListingImageUpload',
        foreignKey: {
          name: 'ListingImageUpload_ownerUserId_fkey',
          columns: ['ownerUserId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
