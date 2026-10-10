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
    // b4-holistic round-4 (HIGH — uploads route fd leak): expose gc cho worker
    // test leak FileHandle (serve + consume + gc → assert KHÔNG có
    // "Closing file descriptor" EBADF). Cờ test-only, vô hại với test khác.
    execArgv: ["--expose-gc"],
  },
});
