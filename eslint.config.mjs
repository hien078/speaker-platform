import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // quy ước: biến cố ý không dùng (vị trí destructure...) đặt tên _*
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma 8 generated artefacts — không lint code sinh tự động
    "src/prisma/contract.d.ts",
    "src/prisma/contract.json",
    // Prisma 8 migration snapshot store (content-addressed, phải commit — không phải code app)
    "migrations/**",
    // Prisma CLI skill dirs — vendored tooling do 'prisma skills sync' quản lý, không phải code app
    ".agents/**",
    ".claude/**",
    ".cursor/**",
    ".devin/**",
  ]),
]);

export default eslintConfig;
