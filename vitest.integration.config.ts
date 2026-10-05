import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Config riêng cho integration tests — chạy qua scripts/test-integration.sh
// (spin postgres scratch container + migrate + dọn). Cần DATABASE_URL.
export default defineConfig({
  resolve: {
    alias: {
      "@": root,
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // tuần tự — các test chia sẻ 1 DB scratch, tránh nhiễu
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
