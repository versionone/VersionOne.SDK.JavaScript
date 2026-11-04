#!/usr/bin/env node
// Runs the integration tier: vitest with SDK_TEST_TIER=integration. A tiny
// launcher instead of a cross-env dependency; extra args go to vitest.
import { spawnSync } from "node:child_process";
// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set (Node >=
// 22.21); behind a proxy (a cloud agent environment, a corporate network)
// every live request would fail with "fetch failed" before leaving the box.
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
const env = { ...process.env, SDK_TEST_TIER: "integration", ...(proxied && !process.env.NODE_USE_ENV_PROXY ? { NODE_USE_ENV_PROXY: "1" } : {}) };
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", ...process.argv.slice(2)], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exitCode = r.status ?? 1;
