import { assertNotReference } from "../integration/referenceData";
import { describe, expect, it } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { problemWith } from "../integration/memberCheck";

/**
 * The integration tier's preflight, against a fake transport: it says what
 * the member lacks in one message, and leaves nothing behind when all is
 * well. The refusal is the server's own, from a run by a member with an
 * admin role and no project membership.
 */
const envelope = (over: Record<string, unknown>) => ({ requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [], count: 0 }, queryResult: { results: [], count: -1 }, ...over });
function instanceWhere(rule: { seesProject: boolean; creates: boolean; deletes?: boolean }): Transport & { writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    request: (async (o: RequestOptions) => {
      const [command] = o.body as Record<string, unknown>[];
      if (command!.from === "Member") return envelope({ queryResult: { results: [[{ _oid: "Member:20", Name: "CI Member" }]], count: 1 } });
      if (command!.from === "Scope:0") return envelope({ queryResult: { results: [rule.seesProject ? [{ _oid: "Scope:0", Name: "System (All Projects)" }] : []], count: 1 } });
      writes.push(command);
      if (command!.AssetType === "Story") return rule.creates ? envelope({ assetsCreated: { oidTokens: ["Story:900:1"], count: 1 } }) : envelope({ commandFailures: { count: 1, commands: [{ ...command, error: { message: "Violation'Invalid'Story.Scope", sourceCommandIndex: 0 } }] } });
      return rule.deletes === false ? envelope({ commandFailures: { count: 1, commands: [{ ...command, error: { message: "Security'Delete'Story", sourceCommandIndex: 0 } }] } }) : envelope({ assetsOperatedOn: { oidTokens: ["Story:900:2"], count: 1 } });
    }) as Transport["request"]
  };
}

describe("the integration tier's preflight", () => {
  it("a member that can see the project and create and delete a Story has no problem, and its probe Story is deleted by exact OID", async () => {
    const t = instanceWhere({ seesProject: true, creates: true });
    expect(await problemWith(t)).toBeNull();
    expect(t.writes).toEqual([expect.objectContaining({ AssetType: "Story", Scope: "Scope:0", Name: expect.stringMatching(/^sdk-integration preflight /) }), { from: "Story:900", execute: "Delete" }]);
  });

  it("a member with no project membership gets one message: who, what it cannot do, the server's words, and what it needs", async () => {
    const unseen = await problemWith(instanceWhere({ seesProject: false, creates: false }));
    expect(unseen).toMatch(/cannot run as CI Member \(Member:20\): it cannot see the system project \(Scope:0\)\. The member the tier runs as must belong to the system project/);
    const refused = await problemWith(instanceWhere({ seesProject: true, creates: false }));
    expect(refused).toMatch(/cannot create a Story in the system project \(Scope:0\); the server answered "Violation'Invalid'Story\.Scope"\. The member .* role that can create and delete work items/);
  });

  it("a member that can create and not delete is told so, with the Story it left, before any suite adds more", async () => {
    expect(await problemWith(instanceWhere({ seesProject: true, creates: true, deletes: false }))).toMatch(/created Story:900 and cannot delete it/);
  });
});

describe("the guard on permanent reference data", () => {
  // query.v1 answers one list per query; here one query per asset type, each filtered by that type's OIDs.
  const names: Record<string, string> = { "Team:152495": "sdk-reference team", "StoryStatus:152497": "SDK-Reference In Progress", "Story:7": "sdk-integration story", "Team:9": "a team about the sdk-reference data" };
  const answering = (): Transport & { asked: { from: string; with: { $oids: string[] } }[][] } => {
    const asked: { from: string; with: { $oids: string[] } }[][] = [];
    return { asked, request: (async (o: RequestOptions) => { const body = o.body as { from: string; with: { $oids: string[] } }[]; asked.push(body); return body.map((q) => q.with.$oids.filter((oid) => oid in names).map((oid) => ({ _oid: oid, Name: names[oid] }))); }) as Transport["request"] };
  };

  it("refuses a cleanup list that holds anything named sdk-reference, by the name the instance has now, and says which", async () => {
    const t = answering();
    await expect(assertNotReference(t, ["Story:7", "Team:152495:3", "StoryStatus:152497"])).rejects.toThrow(/refusing to delete permanent reference data.*Team:152495 "sdk-reference team", StoryStatus:152497 "SDK-Reference In Progress".*Nothing was deleted/);
    // One request, one query per type, each asking only for its own type's OIDs (a mixed ID filter is an error on the server).
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.map((q) => [q.from, q.with.$oids])).toEqual([["Story", ["Story:7"]], ["Team", ["Team:152495"]], ["StoryStatus", ["StoryStatus:152497"]]]);
  });

  it("lets through fixtures, assets already gone, and a name that merely mentions the prefix; an unreadable name is a refusal", async () => {
    await expect(assertNotReference(answering(), ["Story:7", "Story:404", "Team:9"])).resolves.toBeUndefined();
    await expect(assertNotReference(answering(), [])).resolves.toBeUndefined();
    const failing: Transport = { request: (async () => { throw new Error("down"); }) as Transport["request"] };
    await expect(assertNotReference(failing, ["Story:7"])).rejects.toThrow("down");
  });
});
