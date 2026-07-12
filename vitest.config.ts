import path from "node:path"
import { defineConfig } from "vitest/config"

// Unit tests for the pure engine math (no DOM, no network). We map the `@/…` alias to the
// project root so tests import the same modules the app does.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
})
