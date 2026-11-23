/**
 * The schema service: the instance's asset types, loaded from meta.v1 one
 * type at a time as queries need them, and handed to the wire layer as the
 * AttributeLookup it translates rows with.
 *
 * Why lazy: the whole metamodel is ~7 MB and 165 types, and a consumer
 * touches a dozen. Why a service and not the wire module: loading is
 * asynchronous and cross-cutting (one cache per client, in-flight requests
 * deduplicated — the pattern a browser app consumer's metamodel store proves),
 * while translation is synchronous and per row. A schema can also be seeded
 * from a metamodel document (a committed metamodel.json, or one read with
 * meta.getMetamodel) and then needs no transport at all.
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { AssetType, AssetTypeToken, AttributeDefinition, AttributeLookup, Metamodel } from "../types/metamodel";
import * as meta from "../wire/meta";
import { attributeOf, fromTypeOf, typesNeeded, type SelectShape } from "../wire/select";

/**
 * The type definitions loaded from one instance, shareable by any number of
 * schemas. A definition does not depend on who read it, so a server that
 * builds a client per user (each with that user's token) can give them all
 * one cache per instance: each type is fetched once, through whichever
 * client needed it first, and concurrent loads of a type share one request.
 */
export class TypeCache {
  /** Loaded types; null records that the instance has no such type, so it is not asked for again. */
  readonly types = new Map<AssetTypeToken, AssetType | null>();
  readonly loading = new Map<AssetTypeToken, Promise<AssetType | null>>();
  /** The schema's tag the loaded types came with (meta.v1's ETag, one for the whole schema); null until a load, or for a seeded cache. */
  etag: string | null = null;

  /** Forget every loaded type (and the tag): the next query loads afresh. In-flight loads finish into the cache as before. */
  clear(): void {
    this.types.clear();
    this.etag = null;
  }

  /** A cache seeded from a metamodel document. */
  static fromMetamodel(metamodel: Metamodel): TypeCache {
    const cache = new TypeCache();
    for (const [token, type] of Object.entries(metamodel.AssetTypes)) cache.types.set(token, type);
    return cache;
  }
}

export class Schema implements AttributeLookup {
  private readonly types: Map<AssetTypeToken, AssetType | null>;
  private readonly loading: Map<AssetTypeToken, Promise<AssetType | null>>;
  /** Where this schema keeps what it loads; pass it to another schema to share it. */
  readonly cache: TypeCache;

  constructor(private readonly transport?: Transport, seed?: Metamodel, cache: TypeCache = new TypeCache()) {
    this.cache = cache;
    this.types = cache.types;
    this.loading = cache.loading;
    if (seed) for (const [token, type] of Object.entries(seed.AssetTypes)) if (!this.types.has(token)) this.types.set(token, type);
  }

  /** The same cache, loading anything missing through another transport (another user's credentials). */
  withTransport(transport: Transport): Schema {
    return new Schema(transport, undefined, this.cache);
  }

  /** A complete schema from a metamodel document; nothing is ever fetched. */
  static fromMetamodel(metamodel: Metamodel): Schema {
    return new Schema(undefined, metamodel);
  }

  /** The type, null when the instance has none, undefined when not loaded yet. */
  assetType(token: AssetTypeToken): AssetType | null | undefined {
    return this.types.has(token) ? this.types.get(token)! : undefined;
  }

  /** An attribute by bare name; undefined when the type is not loaded, null when it has no such attribute. */
  attribute(type: AssetTypeToken, name: string): AttributeDefinition | null | undefined {
    return attributeOf(this, type, name);
  }

  /**
   * Can the type do this operation (Delete, Reactivate, …)? Undefined when
   * the type is not loaded or its definition carries no operations, so a
   * caller can tell "no" from "don't know".
   */
  canOperate(type: AssetTypeToken, op: string): boolean | undefined {
    const t = this.assetType(type);
    return t?.Operations ? t.Operations.includes(op) : undefined;
  }

  /** The tokens loaded so far. */
  get loaded(): AssetTypeToken[] {
    return [...this.types.entries()].filter(([, t]) => t !== null).map(([token]) => token);
  }

  /**
   * Load one type from meta.v1 (once; concurrent callers share the request).
   * A type the instance does not have resolves to null and is remembered;
   * any other failure (auth, network) is thrown, not swallowed.
   */
  async load(token: AssetTypeToken): Promise<AssetType | null> {
    if (this.types.has(token)) return this.types.get(token)!;
    const inFlight = this.loading.get(token);
    if (inFlight) return inFlight;
    if (!this.transport) { this.types.set(token, null); return null; }
    const request = meta.readAssetType(this.transport, token)
      .then((read) => { if (read?.etag) this.cache.etag = read.etag; return read ? read.value : null; })
      .catch((error: unknown) => { if (error instanceof ApiError && error.status === 404) return null; throw error; })
      .then((type) => { this.types.set(token, type); return type; })
      .finally(() => this.loading.delete(token));
    this.loading.set(token, request);
    return request;
  }

  /**
   * Has the instance's schema changed since these types were loaded? One
   * small conditional read of meta.v1. Unchanged: nothing happens.
   * Changed (or never tagged, or the transport cannot see headers): the
   * loaded types are dropped, so the next query loads them again, and the
   * new tag is kept. Answers whether it changed and the current tag. A
   * schema without a transport (seeded) never changes.
   */
  async revalidate(): Promise<{ changed: boolean; etag: string | null }> {
    if (!this.transport) return { changed: false, etag: this.cache.etag };
    const was = this.cache.etag;
    const now = await meta.etag(this.transport, { ifNoneMatch: was });
    if (was && now === was) return { changed: false, etag: was };
    this.cache.clear();
    this.cache.etag = now;
    return { changed: true, etag: now };
  }

  /**
   * Load whatever the queries in a batch need to have their rows translated:
   * the `from` types, then the types behind every relation hop and sub-select,
   * until nothing more is needed. Non-query commands are ignored.
   */
  async ensureFor(commands: readonly unknown[]): Promise<void> {
    for (const command of commands) {
      const query = queryOf(command);
      if (!query) continue;
      const type = fromTypeOf(query.from, commands);
      if (!type) continue;
      for (let round = 0; round < 32; round += 1) {
        const needed = [...typesNeeded(this, query, type)].filter((t) => !this.types.has(t));
        if (!needed.length) break;
        await Promise.all(needed.map((t) => this.load(t)));
      }
    }
  }
}

/** The query body of a command (bare or aliased), or null when it is not a query. */
export function queryOf(command: unknown): SelectShape | null {
  if (!command || typeof command !== "object") return null;
  const keys = Object.keys(command);
  const body = (keys.length === 1 && keys[0]!.startsWith("@") ? (command as Record<string, unknown>)[keys[0]!] : command) as Record<string, unknown>;
  if (!body || typeof body !== "object" || typeof body.from !== "string") return null;
  if ("update" in body || "execute" in body || "AssetType" in body) return null;
  return body as unknown as SelectShape;
}
