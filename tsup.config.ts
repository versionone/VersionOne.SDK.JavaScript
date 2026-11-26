import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public import path: the root, `/wire` (the endpoints' own
  // shapes) and `/testing` (FakeAgilityClient). Code they share is split
  // into chunks in both formats, so a class is the same class whichever
  // path it was imported through (`instanceof ApiError` holds across them).
  entry: { index: "src/index.ts", wire: "src/wire/index.ts", testing: "src/testing/index.ts" },
  format: ["esm", "cjs"],
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22"
});