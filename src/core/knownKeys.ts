import { UsageError } from "./errors";

/** Edit distance between two short names, for "did you mean". */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The known key nearest to a mistyped one, when one is close: the same but for case, or one or two edits away. */
function nearest(key: string, known: readonly string[]): string | null {
  const exact = known.find((k) => k.toLowerCase() === key.toLowerCase());
  if (exact) return exact;
  const [best] = known.map((k) => [k, distance(key.toLowerCase(), k.toLowerCase())] as const).filter(([k, d]) => d <= 2 && d < Math.max(k.length, key.length) / 2).sort((x, y) => x[1] - y[1]);
  return best ? best[0] : null;
}

/**
 * A config object with a key its factory does not know is a mistake in the
 * call, and is refused when the object is handed over: a misspelt or
 * misplaced option that is quietly ignored leaves a caller believing it
 * was applied. The name is the mistake, so a key is refused whatever its
 * value, `undefined` included. The message names the keys and never a
 * value: a config holds credentials.
 */
export function refuseUnknownKeys(what: string, config: unknown, known: readonly string[]): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new UsageError(`${what} must be an object`);
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (!unknown.length) return;
  const said = unknown.map((key) => { const near = nearest(key, known); return near ? `"${key}" (did you mean "${near}"?)` : `"${key}"`; });
  throw new UsageError(`${what}: unknown key${unknown.length > 1 ? "s" : ""} ${said.join(", ")}. It takes: ${known.join(", ")}`, { unknown, known: [...known] });
}

/** The names of a config type's keys, as a list that cannot drift from the type: a key missing here or extra here does not compile. */
export const keysOf = <T>() => <const K extends Record<keyof T, true>>(keys: K & Record<Exclude<keyof K, keyof T>, never>): readonly (keyof T & string)[] => Object.keys(keys) as (keyof T & string)[];
