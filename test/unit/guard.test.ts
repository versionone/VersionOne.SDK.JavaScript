import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { UnguardableError, guard, passesOf, sendGuarded, sendPasses, touchedBy, unguardable } from "../../src/services/guard";
import type { Command } from "../../src/wire/assetApi";

const envelope = (over: Record<string, unknown> = {}) => ({
  requestId: "r", createdDate: "t", completedDate: "t", duration: "0", durationSeconds: 0, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over
});
function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}

// The projection exactly as the server returned it (live, 2026-11-04): a
// query-scoped update and execute expanded per asset under generated
// aliases, a scalar normalised to add/remove like a multi-value relation.
const PROJECTED: Command[] = [
  { "@c4eeb2cd-88cb-4e24-ba68-6d5634cea35e": { oid: "Story:146020", update: { Estimate: { add: ["2"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } } } as unknown as Command,
  { "@65ed06bd-398b-4bdd-9043-d9028d85e87b": { oid: "Story:146021", execute: { op: "Inactivate", args: {} } } } as unknown as Command,
  { "@new": { AssetType: "Task", Name: "t", Parent: "Story:146020" } }
];

describe("guard", () => {
  it("rewrites each projected per-asset command as a query-scoped one on its ID (a variable) and ChangeDate (a literal — as a variable it never matches); creates pass through", () => {
    expect(touchedBy(PROJECTED)).toEqual(["Story:146020", "Story:146021"]);
    const { commands, unstamped } = guard(PROJECTED, { "Story:146020": "2026-11-04T16:49:40.12", "Story:146021": "2026-11-04T16:49:39.893" });
    expect(unstamped).toEqual([]);
    expect(commands).toEqual([
      { from: "Story", filter: ["ID=$oid", "ChangeDate='2026-11-04T16:49:40.12'"], with: { $oid: "Story:146020" }, update: { Estimate: { add: ["2"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } },
      { from: "Story", filter: ["ID=$oid", "ChangeDate='2026-11-04T16:49:39.893'"], with: { $oid: "Story:146021" }, execute: { op: "Inactivate", args: {} } },
      { "@new": { AssetType: "Task", Name: "t", Parent: "Story:146020" } }
    ]);
  });

  it("an asset with no stamp (gone since the preview) is left out and reported, not sent unguarded; a stamp that is not a timestamp never reaches a filter", () => {
    const { commands, unstamped } = guard(PROJECTED.slice(0, 2), { "Story:146021": "2026-11-04T16:49:39.893" });
    expect(unstamped).toEqual(["Story:146020"]);
    expect(commands).toHaveLength(1);
    expect(() => guard(PROJECTED.slice(0, 1), { "Story:146020": "2026-11-04' | ID!='x" })).toThrow(/not a timestamp/);
  });

  it("names the shapes it cannot cover, by index: an aliased update or execute, a bare one from an alias, an update with inline creates", () => {
    expect(unguardable([
      { from: "Story", filter: ["Estimate>'3'"], update: { Estimate: 3 } },
      { "@u": { from: "Story:1", update: { Name: "x" } } },
      { from: "@s", execute: "Inactivate" },
      { from: "Story:1", update: { Children: { add: [{ AssetType: "Task", Name: "t" }] } } }
    ]).map((u) => u.index)).toEqual([1, 2, 3]);
  });

  it("sendGuarded: preview, read ChangeDates, send guarded and marked idempotent (no creates); assets the response did not touch are skipped", async () => {
    const t = fakeTransport(
      PROJECTED.slice(0, 2),
      envelope({ queryResult: { results: [[{ _oid: "Story:146020", ChangeDate: "2026-11-04T16:49:40.12" }, { _oid: "Story:146021", ChangeDate: "2026-11-04T16:49:39.893" }]], resultMetaData: [], count: 2 } }),
      // Story:146021 changed in between: its guarded execute matched nothing.
      envelope({ assetsModified: { oidTokens: ["Story:146020:193001"], count: 1 } })
    );
    const res = await sendGuarded(t, [{ from: "Story", filter: ["Number=$n"], with: { $n: ["S-1", "S-2"] }, update: { Estimate: 2 } }]);
    expect(t.calls.map((c) => c.query?.previewOnly ?? "send")).toEqual(["true", "send", "send"]);
    expect(t.calls[1]!.body).toEqual([{ from: "Story", select: ["ChangeDate"], filter: ["ID=$oids"], with: { $oids: ["Story:146020", "Story:146021"] }, page: { size: 2, start: 0 } }]);
    expect(t.calls[2]!.idempotent).toBe(true);
    expect(res.stamps).toEqual({ "Story:146020": "2026-11-04T16:49:40.12", "Story:146021": "2026-11-04T16:49:39.893" });
    expect(res.skipped).toEqual(["Story:146021"]);
  });

  it("a guarded batch with a create is not marked idempotent — a resend would create twice", async () => {
    const t = fakeTransport(PROJECTED, envelope({ queryResult: { results: [[{ _oid: "Story:146020", ChangeDate: "2026-11-04T16:49:40.12" }, { _oid: "Story:146021", ChangeDate: "2026-11-04T16:49:39.893" }]], resultMetaData: [], count: 2 } }), envelope());
    await sendGuarded(t, [{ from: "Story", update: { Estimate: 2 } }]);
    expect(t.calls[2]!.idempotent).toBe(false);
  });

  it("refuses an unguardable batch before any request, and anything of the Ideas product, which has no ChangeDate", async () => {
    const none = fakeTransport();
    await expect(sendGuarded(none, [{ "@u": { from: "Story:1", update: { Name: "x" } } }])).rejects.toBeInstanceOf(UnguardableError);
    expect(none.calls).toHaveLength(0);
    const ideas = fakeTransport([{ "@x": { oid: "Idea:7", update: { Name: { add: ["y"], remove: [] } } } }]);
    await expect(sendGuarded(ideas, [{ from: "Idea:7", update: { Name: "y" } }])).rejects.toThrow(/Idea has no ChangeDate/);
    expect(ideas.calls).toHaveLength(1); // the preview only
  });
});

describe("guard passes: two commands on one asset", () => {
  const P = (oid: string, cmd: Record<string, unknown>) => ({ [`@${oid.replace(":", "")}${Object.keys(cmd)[0]}`]: { oid, ...cmd } }) as unknown as Command;
  const env = (over: Record<string, unknown> = {}) => ({ requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over });

  it("passesOf puts an asset's second command in a second pass; creates ride in the first", () => {
    const create = { "@t": { AssetType: "Task", Name: "x" } } as Command;
    const passes = passesOf([create, P("Story:1", { execute: { op: "Reactivate", args: {} } }), P("Story:2", { execute: { op: "Delete", args: {} } }), P("Story:1", { execute: { op: "Delete", args: {} } })]);
    expect(passes.map((p) => p.length)).toEqual([3, 1]);
    expect(passes[1]![0]).toEqual(P("Story:1", { execute: { op: "Delete", args: {} } }));
  });

  it("the second pass goes only for assets whose first command applied, guarded on the ChangeDate read just after it", async () => {
    const sent: unknown[][] = [];
    const transport = { request: vi.fn(async (o: { body: unknown[] }) => {
      const body = o.body as Record<string, unknown>[];
      if (body.length === 1 && (body[0]!.select as string[] | undefined)?.[0] === "ChangeDate") return env({ queryResult: { results: [[{ _oid: "Story:1", ChangeDate: "2026-11-07T12:00:00.5" }]], resultMetaData: [], count: 1 } });
      sent.push(body);
      // Pass 1: Story:1 applies, Story:2 was changed by someone else and matches nothing.
      return sent.length === 1 ? env({ assetsOperatedOn: { oidTokens: ["Story:1:77"], count: 1 } }) : env({ assetsOperatedOn: { oidTokens: ["Story:1"], count: 1 } });
    }) } as unknown as Parameters<typeof sendPasses>[0];
    const projected = [P("Story:1", { execute: { op: "Reactivate", args: {} } }), P("Story:2", { execute: { op: "Reactivate", args: {} } }), P("Story:1", { execute: { op: "Delete", args: {} } }), P("Story:2", { execute: { op: "Delete", args: {} } })];
    const r = await sendPasses(transport, projected, { "Story:1": "2026-11-07T11:00:00.1", "Story:2": "2026-11-07T11:00:00.2" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([{ from: "Story", filter: ["ID=$oid", "ChangeDate='2026-11-07T12:00:00.5'"], with: { $oid: "Story:1" }, execute: { op: "Delete", args: {} } }]); // Story:2's Delete never sent
    expect(r.sent).toHaveLength(3);
    expect(r.outcome.operated).toEqual(["Story:1", "Story:1"]);
  });
});
