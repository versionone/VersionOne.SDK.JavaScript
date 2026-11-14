/**
 * Where the integration tier may write fixtures. Pure, so the unit tier
 * can check it without resolving an instance: a local instance always; a
 * hosted one (v1host.com) only when named in SDK_TEST_ALLOWED_INSTANCES;
 * anything named V1Production never.
 */
const HOSTED = /v1host\.com/i;
export const trim = (url: string): string => url.replace(/\/+$/, "");
export const isHosted = (url: string): boolean => HOSTED.test(url);

/** Hosted instances set aside for API testing: SDK_TEST_ALLOWED_INSTANCES, comma-separated base URLs. */
export const apiTestInstances = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.SDK_TEST_ALLOWED_INSTANCES ?? "").split(",").map((u) => trim(u.trim()).toLowerCase()).filter(Boolean);

export const permitted = (url: string, allowed: string[]): boolean =>
  !/V1Production/i.test(url) && (!isHosted(url) || allowed.includes(trim(url).toLowerCase()));
