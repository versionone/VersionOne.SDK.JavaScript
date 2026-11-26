import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public import path: the root, `/wire` (the endpoints' own
  // shapes), `/services` (the services as free functions) and `/testing`
  // (FakeAgilityClient). Every entry and chunk lands in one flat dist/. Code they share is split
  // into chunks in both formats, so a class is the same class whichever
  // path it was imported through (`instanceof ApiError` holds across them).
  entry: { index: "src/index.ts", wire: "src/wire/index.ts", services: "src/services/index.ts", testing: "src/testing/index.ts" },
  format: ["esm", "cjs"],
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22"
});