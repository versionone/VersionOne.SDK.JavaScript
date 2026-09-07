#!/usr/bin/env node
// Runs the integration tier: vitest with SDK_TEST_TIER=integration. A tiny
// launcher instead of a cross-env dependency; extra args go to vitest.
import { spawnSync } from "node:child_process";
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, SDK_TEST_TIER: "integration" }, shell: process.platform === "win32" });
process.exitCode = r.status ?? 1;
