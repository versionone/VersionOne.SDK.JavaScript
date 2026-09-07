import { defineConfig } from "vitest/config";

// Two tiers. Unit tests run against a fake Transport and need nothing;
// `npm test` runs them. Integration tests verify the same modules against a
// real dev instance (test/integration/instance.ts says which) and run on
// demand with `npm run test:integration`; without an instance they skip
// with a message rather than fail.
const integration = process.env.SDK_TEST_TIER === "integration";
export default defineConfig({
  test: {
    environment: "node",
    include: integration ? ["test/integration/**/*.test.ts"] : ["test/unit/**/*.test.ts"],
    testTimeout: integration ? 30_000 : 5_000,
    // One live suite at a time: the custom-fields suite recycles the app
    // domain, which would fail any other suite talking to the instance.
    fileParallelism: !integration
  }
});
