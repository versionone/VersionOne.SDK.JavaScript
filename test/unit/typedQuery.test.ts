import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import type { Asset, Ref } from "../../src/types/asset";
import type { Story } from "../../src/types/assets/Story";
import type { StoryStatus } from "../../src/types/assets/StoryStatus";
import type { QueryBody } from "../../src/wire/assetApi";

/**
 * What the types say about a query (src/types/query.ts). The assertions
 * here are checked by `npm run typecheck`, which `verify` runs; at run
 * time the fake answers nothing of interest.
 */
const request = vi.fn(async (o: { path: string }) => (o.path === "/api/asset" ? { queryResult: { results: [[{ _oid: "Story:1", Name: "n" }]], resultMetaData: [{ total: 1 }] } } : [[{ _oid: "Story:1", Name: "n" }]]));
const t: Transport = { request: request as unknown as Transport["request"] };
const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: Schema.fromMetamodel({ Version: "0", AssetTypes: {} }) });

describe("typed queries", () => {
  it("a literal from and select type the rows by what was selected; an unselected key is a compile error", async () => {
    const rows = await client.query({ from: "Story", select: ["Name", "Estimate", "Status", "Status.Name", "Owners.@Count", { from: "Owners", select: ["Name"] }], page: { size: 1, start: 0 } });
    expectTypeOf(rows[0]!._oid).toEqualTypeOf<string>();
    expectTypeOf(rows[0]!.Name).toEqualTypeOf<string>();
    expectTypeOf(rows[0]!.Estimate).toEqualTypeOf<number | null | undefined>();
    expectTypeOf(rows[0]!.Status).toEqualTypeOf<Ref<StoryStatus> | null | undefined>();
    expectTypeOf(rows[0]!["Status.Name"]).toEqualTypeOf<unknown>();
    expectTypeOf(rows[0]!["Owners.@Count"]).toEqualTypeOf<number>();
    expectTypeOf(rows[0]!.Owners).toEqualTypeOf<Ref<import("../../src/types/assets/Member").Member>[]>();
    // @ts-expect-error Nmae was not selected (and is not an attribute)
    rows[0]!.Nmae;
    expect(rows).toHaveLength(1);
  });

  it("an OID token as from types the rows by its type; get does the same", async () => {
    const [byOid] = await client.query({ from: "Story:1055", select: ["Name"], page: { size: 1, start: 0 } });
    expectTypeOf(byOid!.Name).toEqualTypeOf<string>();
    const got = await client.get("Story:1055", ["Name", "Number"]);
    expectTypeOf(got).toEqualTypeOf<(Asset & { Name: string; Number: string | null | undefined }) | null>();
  });

  it("queries types each slot by its own query", async () => {
    request.mockResolvedValueOnce([[{ _oid: "Story:1", Name: "n" }], [{ _oid: "Scope:0", Name: "s" }]]);
    const [stories, scopes] = await client.queries([
      { from: "Story", select: ["Name", "Estimate"], page: { size: 1, start: 0 } },
      { from: "Scope", select: ["Name"], page: { size: 1, start: 0 } }
    ]);
    expectTypeOf(stories[0]!.Estimate).toEqualTypeOf<number | null | undefined>();
    expectTypeOf(scopes[0]!.Name).toEqualTypeOf<string>();
    // @ts-expect-error Estimate was not selected on Scope
    scopes[0]!.Estimate;
  });

  it("an explicit row type, a variable from or select, and a QueryBody-typed body all behave as before", async () => {
    const explicit = await client.query<Story>({ from: "Story", select: ["Name"], page: { size: 1, start: 0 } });
    expectTypeOf(explicit[0]!).toEqualTypeOf<Story>();
    const from: string = "Story", select: string[] = ["Name"];
    const loose = await client.query({ from, select, page: { size: 1, start: 0 } });
    expectTypeOf(loose[0]!._oid).toEqualTypeOf<string>();
    expectTypeOf(loose[0]!.Anything).toEqualTypeOf<unknown>();
    const body: QueryBody = { from: "Story", select: ["Name", { from: "Status", select: ["Name"] }], page: { size: 1, start: 0 } };
    const typed = await client.query(body);
    expectTypeOf(typed).toEqualTypeOf<Asset[]>();
    // A type the model does not know, and any path, are still accepted.
    const custom = await client.query({ from: "SomeNewType", select: ["Whatever", "Custom_Field"], page: { size: 1, start: 0 } });
    expectTypeOf(custom[0]!.Whatever).toEqualTypeOf<unknown>();
    const page = await client.queryPage({ from: "Story", select: ["Name"], page: { size: 1, start: 0 } });
    expectTypeOf(page.rows[0]!.Name).toEqualTypeOf<string>();
    expect(explicit.length + loose.length + typed.length + custom.length).toBeGreaterThan(0);
  });
});
