import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import type { Story } from "../../src/types/assets/Story";
import { fromAssetDocument, get, history, list, operate, template, toQuery, type AssetDocument, type AssetsDocument } from "../../src/wire/rest1";

function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}

// A real rest-1 asset, as the dev instance rendered it (names changed).
const storyDoc: AssetDocument = {
  _type: "Asset", href: "/VersionOne.Web/rest-1.v1/Data/Story/2104", id: "Story:2104", Attributes: {
    Name: { _type: "Attribute", name: "Name", value: "Legal Check" },
    Status: { _type: "Relation", name: "Status", value: { _type: "Asset", href: "/VersionOne.Web/rest-1.v1/Data/StoryStatus/137", idref: "StoryStatus:137" } },
    AssetState: { _type: "Attribute", name: "AssetState", value: 128 },
    Estimate: { _type: "Attribute", name: "Estimate", value: 2 },
    Super: { _type: "Relation", name: "Super", value: null },
    "Status.Name": { _type: "Attribute", name: "Status.Name", value: "Accepted" },
    Owners: { _type: "Relation", name: "Owners", value: [{ _type: "Asset", href: "/VersionOne.Web/rest-1.v1/Data/Member/1035", idref: "Member:1035" }, { _type: "Asset", href: "", idref: "Member:20" }] },
    "Owners.Name": { _type: "Attribute", name: "Owners.Name", value: ["Alfred Smith", "Jim Allers"] },
    "Owners.Nickname": { _type: "Attribute", name: "Owners.Nickname", value: ["alfred", "jim"] },
    Number: { _type: "Attribute", name: "Number", value: "S-01530" }
  }
};

describe("rest1: translation", () => {
  it("turns a rest-1 asset into the model shape: Refs for relations (null when unset), display columns folded onto the Refs, AssetState by name, plain values otherwise", () => {
    const row = fromAssetDocument<Story>(storyDoc);
    expect(row._oid).toBe("Story:2104");
    expect(row.Name).toBe("Legal Check");
    expect(row.Estimate).toBe(2);
    expect(row.AssetState).toBe("Closed");
    expect(row.Number).toBe("S-01530");
    expect(row.Super).toBeNull();
    expect(row.Status).toEqual({ _oid: "StoryStatus:137", Name: "Accepted" });
    expect(row.Owners).toEqual([{ _oid: "Member:1035", Name: "Alfred Smith", Nickname: "alfred" }, { _oid: "Member:20", Name: "Jim Allers", Nickname: "jim" }]);
    // The dotted columns stay too, for a caller that selected them by name.
    expect((row as unknown as Record<string, unknown>)["Status.Name"]).toBe("Accepted");
    expect((row as unknown as Record<string, unknown>)["Owners.Name"]).toEqual(["Alfred Smith", "Jim Allers"]);
  });

  it("keeps the moment on a history row's _oid and strips it on a data row", () => {
    const hist: AssetDocument = { _type: "Asset", href: "", id: "Story:2104:2797", Attributes: { ChangeDate: { _type: "Attribute", name: "ChangeDate", value: "2026-07-17T12:29:13.617" } } };
    expect(fromAssetDocument(hist, { history: true })._oid).toBe("Story:2104:2797");
    expect(fromAssetDocument(hist)._oid).toBe("Story:2104");
  });

  it("spells the query string the way rest-1 wants: sel and findin comma-joined, where ';'-joined, with in $name=a,b|… form, page size-first", () => {
    expect(toQuery({ sel: ["Name", "Story.Number"], where: ["AssetType='Story'", "AssetState!='Closed'"], with: { $oids: ["Story:1", "Story:2"], $url: "u" }, find: "order", findin: ["Name", "Description"], sort: ["-ChangeDateUTC"], page: { size: 20, start: 40 }, deleted: false, needTotal: true }))
      .toEqual({ sel: "Name,Story.Number", where: "AssetType='Story';AssetState!='Closed'", with: "$oids=Story:1,Story:2|$url=u", find: "order", findin: "Name,Description", sort: "-ChangeDateUTC", page: "20,40", deleted: "false", needTotal: "true", asof: undefined });
  });
});

describe("rest1: calls", () => {
  it("list reads Data/<Type> with the query, translates every row, and surfaces total only when the server sent one; a read without a page is refused", async () => {
    const envelope: AssetsDocument = { _type: "Assets", total: 54, pageSize: 1, pageStart: 0, Assets: [storyDoc] };
    const t = fakeTransport(envelope);
    const { rows, total, pageSize } = await list<Story>(t, "Story", { sel: ["Name"], page: { size: 1, start: 0 }, needTotal: true });
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/rest-1.v1/Data/Story", responseType: "json" });
    expect(t.calls[0]!.query).toMatchObject({ sel: "Name", page: "1,0", needTotal: "true" });
    expect(rows[0]!.Owners).toHaveLength(2);
    expect(total).toBe(54);
    expect(pageSize).toBe(1);
    const noTotal = fakeTransport({ _type: "Assets", pageSize: 1, pageStart: 0, Assets: [] });
    expect((await list(noTotal, "Story", { page: { size: 1, start: 0 } })).total).toBeNull();
    const unpaged = fakeTransport();
    await expect(list(unpaged, "Story", { sel: ["Name"] } as never)).rejects.toThrow(/without a page/);
    expect(unpaged.calls).toHaveLength(0);
  });

  it("get reads one asset by OID (moment dropped from the path) and history reads Hist/<Type>/<id> keeping each row's moment", async () => {
    const t = fakeTransport(storyDoc, { _type: "History", pageSize: 2, pageStart: 0, Assets: [{ _type: "Asset", href: "", id: "Story:2104:2797", Attributes: {} }, { _type: "Asset", href: "", id: "Story:2104:2650", Attributes: {} }] });
    const one = await get<Story>(t, "Story:2104:99", ["Name", "Owners"]);
    expect(t.calls[0]).toMatchObject({ path: "/rest-1.v1/Data/Story/2104", query: { sel: "Name,Owners" } });
    expect(one._oid).toBe("Story:2104");
    const moments = await history(t, "Story:2104", { sel: ["Name"], page: { size: 2, start: 0 } });
    expect(t.calls[1]!.path).toBe("/rest-1.v1/Hist/Story/2104");
    expect(moments.rows.map((r) => r._oid)).toEqual(["Story:2104:2797", "Story:2104:2650"]);
  });
});

describe("rest-1: operate and template (the two things api/asset cannot answer)", () => {
  // Shapes as v1sdktesting sent them, 2026-11-14.
  it("operate POSTs ?op= with no body and answers the resulting asset: the copy for Copy, momentless, with its moment", async () => {
    const t = fakeTransport({ _type: "Asset", href: "/v1sdktesting/rest-1.v1/Data/Story/146979/194422", id: "Story:146979:194422" });
    expect(await operate(t, "Story:146976:1", "Copy")).toEqual({ oid: "Story:146979", moment: "194422" });
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/rest-1.v1/Data/Story/146976", query: { op: "Copy" } });
    expect(t.calls[0]!.body).toBeUndefined();
    expect(t.calls[0]!.idempotent).toBeUndefined();
    await expect(operate(fakeTransport({ _type: "Asset", id: "" }), "Story:1", "Copy")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(operate(fakeTransport(), "S-1", "Copy")).rejects.toMatchObject({ kind: "usage" });
  });

  it("template GETs New/<Type>?ctx= and answers the initializer's values translated, without an _oid", async () => {
    const doc = { _type: "Asset", href: "/v1sdktesting/rest-1.v1/New/Timebox", id: "", Attributes: {
      State: { _type: "Relation", name: "State", act: "set", value: { _type: "Asset", href: "", idref: "State:100" } },
      Schedule: { _type: "Relation", name: "Schedule", act: "set", value: { _type: "Asset", href: "", idref: "Schedule:3675" } },
      Name: { _type: "Attribute", name: "Name", act: "set", value: "Sprint 7" },
      BeginDate: { _type: "Attribute", name: "BeginDate", act: "set", value: "2015-06-17" },
      Owner: { _type: "Relation", name: "Owner", act: "set", value: { _type: "Asset", href: "", idref: "Member:145820" } }
    } };
    const t = fakeTransport(doc);
    const tpl = await template(t, "Timebox", { ctx: "Scope:0:5" });
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/rest-1.v1/New/Timebox", query: { ctx: "Scope:0" } });
    expect(tpl).toEqual({ State: { _oid: "State:100" }, Schedule: { _oid: "Schedule:3675" }, Name: "Sprint 7", BeginDate: "2015-06-17", Owner: { _oid: "Member:145820" } });
    expect("_oid" in tpl).toBe(false);
    expect(await template(fakeTransport({ _type: "Asset", href: "", id: "", Attributes: {} }), "Story")).toEqual({});
  });
});

