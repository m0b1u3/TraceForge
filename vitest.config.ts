import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scenarios/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 90000,
  },
});
