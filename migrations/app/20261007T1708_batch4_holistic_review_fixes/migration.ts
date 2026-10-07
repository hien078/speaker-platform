#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/177b84a6eddeb3c7b93bdbe6273f0d5eb07c873e676107403880e0ec4d019231/contract';
import startContract from '../../snapshots/177b84a6eddeb3c7b93bdbe6273f0d5eb07c873e676107403880e0ec4d019231/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract';
import endContract from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Listing',
        column: col('approvedContentAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
