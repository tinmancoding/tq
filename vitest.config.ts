import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.{test,spec}.ts"],
    exclude: ["packages/web/**", "**/node_modules/**"],
    environment: "node",
    pool: "forks",
  },
});
