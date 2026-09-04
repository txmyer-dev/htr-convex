import { defineConfig } from "vitest/config";

// Pure modules (convex/lib) run in node; anything touching Convex functions runs in the
// edge runtime, which is what convex-test expects.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["tests/**/*.test.ts"],
  },
});
