import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // khớp tsconfig paths: "@/*" → "./*"
    alias: {
      "@": root,
    },
  },
  test: {
    // Unit tests mặc định — KHÔNG gồm integration (cần scratch DB,
    // chạy qua: npm run test:integration → scripts/test-integration.sh)
    include: ["tests/unit/**/*.test.ts"],
  },
});
