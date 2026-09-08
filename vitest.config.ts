import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scenarios/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 90000,
  },
});
