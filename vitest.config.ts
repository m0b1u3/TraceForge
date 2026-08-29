import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "scenarios/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 90000,
  },
});
