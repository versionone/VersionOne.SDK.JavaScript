/**
 * A client that has loaded no type answers the same as one that has loaded
 * them all.
 *
 * Rows are translated by the schema, and only by types already loaded, so
 * a read that forgets to load what its answer needs is right on a warm
 * client and wrong on a cold one: a suite that shares one client never
 * sees it (`fields.describe` once lost the scope's scheme this way). Every
 * public read that translates is run here twice, on a client made for the
 * call and on one seeded with the whole metamodel, and the answers must be
 * equal. Read-only: nothing is created.
 *
 * A NEW READ METHOD BELONGS IN `reads` BELOW.
 */
import { beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { Schema } from "../../src/services/schema";
import type { TypeCache } from "../../src/services/schema";
import type { Oid } from "../../src/types/asset";
import { describeInstance, instance } from "./instance";

const page = { size: 3, start: 0 };
/** Between calls: the instance is shared. */
const pause = () => new Promise((r) => setTimeout(r, 300));

describeInstance("a cold client answers as a warm one (live)", () => {
  let types: TypeCache;
  let story: Oid | null = null;
  let attached: Oid | null = null;
  let statusName = "";
  const cold = () => new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });
  const warm = () => new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport, types });

  beforeAll(async () => {
    const seed = cold();
    types = Schema.fromMetamodel(await seed.meta.metamodel()).cache;
    story = (await seed.query({ from: "Story", select: ["Name"], sort: ["+ID"], page: { size: 1, start: 0 } }))[0]?._oid ?? null;
    const attachment = (await seed.query({ from: "Attachment", select: ["Asset"], filter: ["Asset.AssetType='Story'"], sort: ["+ID"], page: { size: 1, start: 0 } }))[0] as { Asset?: { _oid: Oid } | null } | undefined;
    attached = attachment?.Asset?._oid ?? null;
    statusName = String((await seed.lists.values({ type: "Story", scope: "Scope:0", attributes: ["Status"] }))["Status"]![0]!.Name);
  }, 120_000);

  const scopeWithScheme = { from: "Scope", select: ["Name", "BeginDate", "Owner.Name", { from: "Scheme", select: ["Name", "ImportantFields", "IsRequiredAtClose"] }], filter: ["ID='Scope:0'"], page: { size: 1, start: 0 } };
  const reads: Record<string, (c: AgilityApiClient) => Promise<unknown>> = {
    "query: scalars, a path, a date and a sub-select": (c) => c.query(scopeWithScheme),
    "queries": (c) => c.queries([scopeWithScheme, { from: "Member", select: ["Name", "DefaultRole.Name", "IsSelf"], filter: ["IsSelf='true'"], page: { size: 1, start: 0 } }]),
    "get": (c) => c.get("Scope:0", ["Name", "BeginDate", "Scheme.Name", "Parent"]),
    "queryPage through a base type": (c) => c.queryPage({ from: "PrimaryWorkitem", select: ["Name", "ChangeDate", "Status.Name", "Scope", "Owners"], sort: ["+ID"], page }),
    "all": (c) => c.all({ from: "StoryStatus", select: ["Name", "Order", "Inactive", "Team"], sort: ["+ID"], page: { size: 5, start: 0 } }, { limit: 5 }),
    "send with a query in the batch": async (c) => (await c.send([scopeWithScheme])).queryResults,
    "sendGuarded with a query in the batch": async (c) => (await c.sendGuarded([scopeWithScheme])).queryResults,
    "search across types": (c) => c.search("sdk", { types: ["Story", "Defect"], select: ["Name", "Number", "ChangeDate", "Scope.BeginDate", "Status.Name"], page }),
    "search in an abstract type": (c) => c.search("sdk", { types: ["PrimaryWorkitem"], select: ["Name", "CreateDate"], page }),
    "deleted through a base type": (c) => c.deleted("PrimaryWorkitem", { select: ["Name", "ChangeDate", "Scope.BeginDate"], sort: ["+ID"], page }),
    "deleted of one type": (c) => c.deleted("Story", { select: ["Name", "ChangeDate"], sort: ["+ID"], page }),
    "history of a type": (c) => c.history("Scope", { select: ["Name", "ChangeDate", "BeginDate"], filter: ["ID='Scope:0'"], page }),
    "history of an asset": (c) => c.history("Scope:0", { select: ["Name", "ChangeDate", "Owner.Name"], page }),
    "history of a base type's asset": async (c) => (story ? c.history(`PrimaryWorkitem:${story.split(":")[1]}`, { select: ["Name", "ChangeDate"], page }) : "no story"),
    "template": (c) => c.template("Story", { ctx: "Scope:0" }),
    "fields.describe": (c) => c.fields.describe("Story", "Scope:0"),
    "fields.describe of a base type": (c) => c.fields.describe("PrimaryWorkitem", "Scope:0"),
    "lists.values for a new asset": (c) => c.lists.values({ type: "Story", scope: "Scope:0", attributes: ["Status", "Priority"], select: ["Name", "Order", "Inactive"] }),
    "lists.values for an asset": async (c) => (story ? c.lists.values({ asset: story, attributes: ["Status", "Source"], select: ["Order", "AssetState"] }) : "no story"),
    "lists.value": (c) => c.lists.value({ type: "Story", scope: "Scope:0", attribute: "Status", name: statusName }),
    "resolve.refs": (c) => c.resolve.refs(["Scope:0", "Member:20", ...(story ? [story] : [])]),
    "attachments.list with a select": async (c) => (attached ? c.attachments.list(attached, { select: ["Asset.Name", "Asset.ChangeDate", "Category.Name"], page }) : "no attachment on a story"),
    "attachments.page with a select": async (c) => (attached ? c.attachments.page(attached, { select: ["Asset.Name", "Asset.ChangeDate"], page }) : "no attachment on a story")
  };

  for (const [name, read] of Object.entries(reads)) {
    it(name, async () => {
      const first = await read(cold());
      await pause();
      const seeded = await read(warm());
      expect(first).toEqual(seeded);
      // An answer of nothing would compare equal whatever the code did.
      expect(JSON.stringify(first ?? null).length, "the read answered nothing to compare").toBeGreaterThan(4);
      await pause();
    }, 60_000);
  }
});
