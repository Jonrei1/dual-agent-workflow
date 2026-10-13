import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    // The tests spawn the installer, git and stub CLIs; separate processes keep their
    // environment variables and working directories apart.
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
