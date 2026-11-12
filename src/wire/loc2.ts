/**
 * The loc-2.v1 wire module: localized labels for Agility's tags.
 *
 * Verified shapes (https://docs.digital.ai/agility-api/apis/loc-2-v1, and a
 * live instance 2026-11-04):
 *   - The whole raw query string is the payload, parsed as LSON (lenient
 *     JSON) — no name=value. An array in gives an object out, keyed by the
 *     tags exactly as sent, duplicates collapsed; a scalar in gives a bare
 *     string. This module only ever sends the array form.
 *   - Tags hold tics (AttributeDefinition'Name'Story) and may hold spaces,
 *     commas or `]`, which split a bare LSON token; a tag starting with a
 *     tic reads as a quote. Every tag is therefore sent double-quoted —
 *     JSON.stringify of the list is valid LSON, escapes and non-ASCII
 *     included (round-tripped live).
 *   - GET for a list that fits a URL; POST of the same payload, URL-encoded
 *     as the body, for a long one. Identical results.
 *   - Accept-Language picks the culture (only its first entry is read; a
 *     neutral culture expands to its default specific one; absent or
 *     unparseable means the invariant culture).
 *   - No authentication: an Authorization header is ignored.
 *   - A tag that matches nothing resolves to itself. There is no "missing"
 *     and no error for it, so a typo is indistinguishable from an
 *     untranslated tag; this module does not pretend otherwise.
 *   - Errors are text/plain, not JSON (a 500 "Server Error" for an element
 *     that is not a string, which the string[] signature rules out).
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";

/** A tag-to-label map, keyed by each tag exactly as sent. */
export type Localizations = Record<string, string>;

export interface LocalizeOptions {
  /** Accept-Language for the request: "fr-CA", "de". Omitted: the server's invariant culture. */
  culture?: string;
  /**
   * The longest encoded payload sent as a GET; longer lists are POSTed.
   * Conservative by default: IIS rejects a query string past 2048
   * characters unless an instance raises the limit.
   */
  maxGetLength?: number;
}

export const DEFAULT_MAX_GET_LENGTH = 2000;

/** The payload as loc-2.v1 parses it: a JSON array of the tags, which is valid LSON. */
export const toLson = (tags: readonly string[]): string => JSON.stringify(tags);

/**
 * Labels for a list of tags, in one request: a map keyed by each tag as
 * sent. An empty list asks nothing of the server and answers {}.
 */
export async function localize(transport: Transport, tags: readonly string[], options: LocalizeOptions = {}): Promise<Localizations> {
  const unique = [...new Set(tags)];
  if (!unique.length) return {};
  const encoded = encodeURIComponent(toLson(unique));
  const headers = options.culture ? { "Accept-Language": options.culture } : undefined;
  const result = encoded.length <= (options.maxGetLength ?? DEFAULT_MAX_GET_LENGTH)
    ? await transport.request<unknown>({ method: "GET", path: `/loc-2.v1?${encoded}`, headers, responseType: "json" })
    // A POST here is a read: safe to send again after a network failure or a 5xx.
    : await transport.request<unknown>({ method: "POST", path: "/loc-2.v1", headers, body: encoded, contentType: "application/x-www-form-urlencoded", responseType: "json", idempotent: true });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ApiError(`loc-2.v1 answered an array of tags with ${JSON.stringify(result)?.slice(0, 100)}, not an object`, 200, "BAD_RESPONSE", result);
  return result as Localizations;
}

/** One tag's label. Sent in the array form like every other call, so parsing stays uniform. */
export async function localizeOne(transport: Transport, tag: string, options: LocalizeOptions = {}): Promise<string> {
  const map = await localize(transport, [tag], options);
  return map[tag] ?? tag;
}
