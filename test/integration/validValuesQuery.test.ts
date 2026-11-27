/**
 * `client.validValues.query` against the server's own answer. The SDK
 * works a relation's valid values out from the rule in the metamodel; the
 * server's valid-values endpoint is the authority on what that rule
 * means. For each relation here the SDK's query is read (bounded, with a
 * total) and compared, asset for asset, with what the endpoint answers.
 *
 * The endpoint cannot be bounded, so it is only asked when the SDK's own
 * total says the answer is short; a relation whose answer is long on this
 * instance is compared by nothing and says so. Read-only: no fixtures.
 */
import { beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { RelationTarget } from "../../src/services/validValuesQuery";
import type { Asset, Oid } from "../../src/types/asset";
import * as validValues from "../../src/wire/validValues";
import { describeInstance, instance } from "./instance";

/** The most assets the endpoint is asked to answer in one piece. */
const SHORT = 150;
const pause = () => new Promise((r) => setTimeout(r, 1200));

describeInstance("validValues.query answers what the valid-values endpoint answers (live)", () => {
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });
  const found: Record<string, Oid | undefined> = {};
  let scope: Oid = "Scope:0";
  let compared = 0;

  beforeAll(async () => {
    const first = async (from: string, filter: string[] = []) => (await client.query({ from, select: ["Name"], filter, sort: ["+ID"], page: { size: 1, start: 0 } } as never) as Asset[])[0]?._oid;
    found["Story"] = await first("Story", ["Scope!='Scope:0'", "AssetState!='Closed'"]);
    for (const type of ["Defect", "Task", "Test", "Epic"]) found[type] = await first(type, ["AssetState!='Closed'"]);
    if (found["Story"]) scope = ((await client.get(found["Story"], ["Scope"])) as unknown as { Scope: { _oid: Oid } }).Scope._oid;
  }, 60_000);

  const read = (q: Record<string, unknown>) => client.queryPage(q as never) as Promise<{ rows: Asset[]; more: boolean }>;

  /** Both answers as sorted OIDs, or null when the answer is too long to ask the endpoint for. */
  async function both(target: RelationTarget, attribute: string): Promise<{ sdk: Oid[]; endpoint: Oid[]; filter: string[] } | null> {
    const q = await client.validValues.query({ ...target, attribute });
    const page = await read({ ...q, select: ["Name"], sort: ["+ID"], page: { size: SHORT, start: 0 } });
    if (page.more) return null;
    await pause();
    const rows = "asset" in target ? await validValues.forAsset(client.transport, target.asset, attribute, {}) : await validValues.forNew(client.transport, target.type, attribute, target.scope, {});
    await pause();
    compared += 1;
    return { sdk: page.rows.map((r) => r._oid).sort(), endpoint: rows.map((r) => r._oid).sort(), filter: q.filter };
  }

  const cases: [string, string, string][] = [
    // type of the asset, attribute, what the case is here for
    ["Story", "Owners", "a rule on an ancestor with $Scope"],
    ["Story", "Parent", "an ancestor's override, a path through the scope's children"],
    ["Story", "Timebox", "a path through the schedule"],
    ["Story", "Team", "a rule with no variable"],
    ["Story", "Customer", "a bare $, and another rule for a new asset"],
    ["Story", "Goals", "a multi-value relation, a bare $ deep in a path"],
    ["Story", "Issues", "no rule at all"],
    ["Defect", "VerifiedBy", "a bare $"],
    ["Defect", "AffectedPrimaryWorkitems", "two terms on the asset itself"],
    ["Task", "Owners", "an override that reads $Parent"],
    ["Test", "Owners", "the same override on another type"],
    ["Epic", "Owners", "another branch of the type tree"]
  ];
  for (const [type, attribute, why] of cases) {
    it(`${type}.${attribute} of an existing asset: ${why}`, async () => {
      const asset = found[type];
      if (!asset) { console.warn(`no ${type} on ${instance!.url}; skipping`); return; }
      const answer = await both({ asset }, attribute);
      if (!answer) { console.warn(`${type}.${attribute} has more than ${SHORT} valid values on ${instance!.url}; not compared`); return; }
      expect(answer.sdk).toEqual(answer.endpoint);
    }, 60_000);
  }
  for (const [type, attribute] of [["Story", "Owners"], ["Story", "Parent"], ["Story", "Timebox"], ["Story", "Customer"], ["Story", "Goals"], ["Epic", "Owners"]] as const) {
    it(`${type}.${attribute} of an asset not created yet`, async () => {
      const answer = await both({ type, scope }, attribute);
      if (!answer) { console.warn(`a new ${type}'s ${attribute} has more than ${SHORT} valid values on ${instance!.url}; not compared`); return; }
      expect(answer.sdk).toEqual(answer.endpoint);
    }, 60_000);
  }

  it("the comparisons compared something: at least one rule with a variable answered assets", async () => {
    if (!found["Story"]) return;
    const answer = await both({ asset: found["Story"] }, "Owners");
    expect(answer?.filter).toEqual(["Scopes=$valid0", "AssetState!=$valid1"]);
    expect(answer!.sdk.length).toBeGreaterThan(0);
  }, 60_000);

  it("most of the comparisons above were made, not skipped for length or for want of an asset", () => {
    if (!found["Story"]) return;
    expect(compared).toBeGreaterThanOrEqual(12);
  });

  it("the query takes a find and a page like any other, and stays within the valid assets", async () => {
    if (!found["Story"]) return;
    const q = await client.validValues.query({ asset: found["Story"], attribute: "Owners" });
    const all = await read({ ...q, select: ["Name"], sort: ["+ID"], page: { size: SHORT, start: 0 } });
    const name = String((all.rows[0] as unknown as { Name: string }).Name);
    const some = await read({ ...q, select: ["Name"], find: name.split(/\s+/)[0]!, findin: ["Name"], page: { size: 5, start: 0 } });
    expect(some.rows.length).toBeGreaterThan(0);
    if (!all.more) for (const row of some.rows) expect(all.rows.map((r) => r._oid)).toContain(row._oid);
  }, 60_000);

  it("a new Task's Owners: the SDK says what the rule needs, and answers with it, where the endpoint can answer nothing for a new task", async () => {
    await expect(client.validValues.query({ type: "Task", scope, attribute: "Owners" })).rejects.toMatchObject({ kind: "usage" });
    if (!found["Story"]) return;
    const q = await client.validValues.query({ type: "Task", scope, context: { Parent: found["Story"] }, attribute: "Owners" });
    expect((await read({ ...q, select: ["Name"], page: { size: 1, start: 0 } })).rows.length).toBe(1);
  }, 60_000);

  it("refuses a list type and points at client.lists", async () => {
    await expect(client.validValues.query({ type: "Story", scope, attribute: "Status" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("client.lists.values") });
  });
});
