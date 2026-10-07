#!/usr/bin/env -S node
import type {
  Contract as End,
  Contract as Start,
} from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract';
import endContract from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract.json' with { type: 'json' };
import startContract from '../../snapshots/66d2193a8ecdd3a6c4dd8c53d30e7a883b4818f443d88e9f7be76a1cd1139717/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';

/**
 * b4-holistic round-4 (LOW deploy-risk — approvedContentAt backfill cho row
 * approved HIỆN CÓ): data-only migration (from == to == contract hash hiện
 * tại — KHÔNG đổi schema; KHÔNG đụng migration đã áp
 * 20261007T1708_batch4_holistic_review_fixes).
 *
 * Vấn đề: cột Listing.approvedContentAt (b4-holistic-2) chỉ được SET bởi
 * approveListingAction (Batch 4+). Mọi row approved TRƯỚC deploy (Batch ≤3,
 * hoặc seed) giữ NULL → toggleListingVisibilityAction hidden→show coi content
 * CHƯA BAO GIỜ được duyệt (listings.ts: approvedContentAt == null → CAS
 * hidden→pending) → tin rơi khỏi chợ công khai chờ admin duyệt lại content
 * ĐÃ duyệt.
 *
 * Backfill: approvedContentAt = updatedAt cho row approved đang NULL —
 * "content hiện tại đã được duyệt tại thời điểm cập nhật gần nhất" (giá trị
 * chỉ là tín hiệu ĐÃ-DUYỆT cho fast path hide→show; timestamp chính xác theo-
 * từng-row không tồn tại trong dữ liệu cũ). Row hidden/pending/rejected/draft
 * GIỮ NULL — không có cách biết content hiện tại có được duyệt hay không
 * (fail-closed: hiện lại → vào review như thiết kế).
 *
 * Data-only self-edge + invariant routing (prisma-8 migration-model): một
 * edge from == to KHÔNG BAO GIỜ được chọn bởi path walk mặc định
 * (findPathWithDecision: from == to && required rỗng → path rỗng) — op khai
 * báo `invariantId` và ref 'production' (migrations/app/refs/production.json)
 * liệt kê invariant đó trong `invariants` → required = ref \ marker buộc
 * đường đi qua edge này đúng MỘT lần; marker ghi lại invariant → chạy lại
 * idempotent (path rỗng).
 *
 * rawSql (escape hatch có trong docs prisma-8 migrations): SET cột-theo-cột
 * (approvedContentAt = updatedAt) không diễn đạt được qua typed update
 * builder (set values là giá trị, không phải expression). Op shape giống hệt
 * dataTransform lower (precheck EXISTS / execute / postcheck NOT EXISTS —
 * cùng hợp đồng "check là rowset, presence-of-any-row = còn việc").
 * Postgres: op chạy trong tx của cả lần db migrate (rollback sạch nếu fail).
 */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'data.backfill-listing-approved-content-at',
        label: 'Data transform: backfill Listing.approvedContentAt cho row approved (b4-holistic round-4)',
        operationClass: 'data',
        // Routing identity — đưa op vào providedInvariants của migration.json
        // (deriveProvidedInvariants) và ref production khai báo nó → db migrate
        // --to production ĐI QUA edge này (xem comment đầu file).
        invariantId: 'backfill-listing-approved-content-at',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'Còn row approved với approvedContentAt NULL (còn việc phải làm)',
            sql: 'SELECT EXISTS (SELECT "id" AS "id" FROM "public"."Listing" WHERE ("status" = $1 AND "approvedContentAt" IS NULL) LIMIT 1) AS ok',
            params: ['approved'],
          },
        ],
        execute: [
          {
            description: 'Backfill approvedContentAt = updatedAt cho row approved đang NULL',
            sql: 'UPDATE "public"."Listing" SET "approvedContentAt" = "updatedAt" WHERE ("status" = $1 AND "approvedContentAt" IS NULL)',
            params: ['approved'],
          },
        ],
        postcheck: [
          {
            description: 'Không còn row approved nào với approvedContentAt NULL',
            sql: 'SELECT NOT EXISTS (SELECT "id" AS "id" FROM "public"."Listing" WHERE ("status" = $1 AND "approvedContentAt" IS NULL) LIMIT 1) AS ok',
            params: ['approved'],
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
