import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { ConflictError, UnguardableError, guard, passesOf, sendGuarded, sendPasses, touchedBy, unguardable } from "../../src/services/guard";
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
  it("rewrites each projected per-asset command as one on that asset at its Moment, while that version is current (both terms, always; both values as variables); creates pass through", () => {
    expect(touchedBy(PROJECTED)).toEqual(["Story:146020", "Story:146021"]);
    const { commands, unstamped } = guard(PROJECTED, { "Story:146020": "196330", "Story:146021": "196333" });
    expect(unstamped).toEqual([]);
    expect(commands).toEqual([
      { from: "Story", where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"], with: { $oid: "Story:146020", $moment: "196330" }, update: { Estimate: { add: ["2"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } },
      { from: "Story", where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"], with: { $oid: "Story:146021", $moment: "196333" }, execute: { op: "Inactivate", args: {} } },
      { "@new": { AssetType: "Task", Name: "t", Parent: "Story:146020" } }
    ]);
  });

  it("an asset with no stamp (gone since the preview) is left out and reported, not sent unguarded; a stamp that is not digits never reaches a query (the server answers one with a 500)", () => {
    const { commands, unstamped } = guard(PROJECTED.slice(0, 2), { "Story:146021": "196333" });
    expect(unstamped).toEqual(["Story:146020"]);
    expect(commands).toHaveLength(1);
    for (const bad of ["196330' | ID!='x", "", "abc", "2026-11-04T16:49:40.12"]) expect(() => guard(PROJECTED.slice(0, 1), { "Story:146020": bad })).toThrow(/is not a Moment/);
    // Never one term without the other: RetireDateUTC='' with no Moment is a server error.
    for (const c of commands) expect(c).toMatchObject({ where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"] });
  });

  it("names the shapes it cannot cover, by index and by a code to branch on: an aliased update or execute, a bare one from an alias, an update with inline creates", () => {
    expect(unguardable([
      { from: "Story", filter: ["Estimate>'3'"], update: { Estimate: 3 } },
      { "@u": { from: "Story:1", update: { Name: "x" } } },
      { from: "@s", execute: "Inactivate" },
      { from: "Story:1", update: { Children: { add: [{ AssetType: "Task", Name: "t" }] } } }
    ]).map((u) => [u.index, u.code])).toEqual([[1, "aliasedWrite"], [2, "bareAliasFrom"], [3, "inlineCreate"]]);
  });

  it("sendGuarded: preview, read Moments, send guarded and marked idempotent (no creates); the result is the Outcome plus the assets whose command matched nothing", async () => {
    const t = fakeTransport(
      PROJECTED.slice(0, 2),
      envelope({ queryResult: { results: [[{ _oid: "Story:146020", Moment: "196330" }, { _oid: "Story:146021", Moment: "196333" }]], resultMetaData: [], count: 2 } }),
      // Story:146021 changed in between: its guarded execute matched nothing.
      envelope({ assetsModified: { oidTokens: ["Story:146020"], count: 1 } })
    );
    const res = await sendGuarded(t, [{ from: "Story", filter: ["Number=$n"], with: { $n: ["S-1", "S-2"] }, update: { Estimate: 2 } }]);
    expect(t.calls.map((c) => c.query?.previewOnly ?? "send")).toEqual(["true", "send", "send"]);
    expect(t.calls[1]!.body).toEqual([{ from: "Story", select: ["Moment"], filter: ["ID=$oids"], with: { $oids: ["Story:146020", "Story:146021"] }, page: { size: 2, start: 0 } }]);
    expect(t.calls[2]!.idempotent).toBe(true);
    expect(res.details.stamps).toEqual({ "Story:146020": "196330", "Story:146021": "196333" });
    expect(res).toMatchObject({ requestId: "r", modified: ["Story:146020"], operated: [], failures: [], touched: ["Story:146020", "Story:146021"], conflicts: ["Story:146021"] });
    expect(res.details.sent).toHaveLength(2);
  });

  it("a command that matched and failed is a failure, not a conflict; with throwOnFailure a conflict throws a ConflictError carrying the result", async () => {
    const stamps = envelope({ queryResult: { results: [[{ _oid: "Story:146020", Moment: "196330" }, { _oid: "Story:146021", Moment: "196333" }]], resultMetaData: [], count: 2 } });
    const failing = fakeTransport(PROJECTED.slice(0, 2), stamps, envelope({ commandFailures: { count: 1, commands: [{ error: { message: "Violation'Invalid'AttributeDefinition'Status'Story", sourceCommandIndex: 1 } }] }, assetsModified: { oidTokens: ["Story:146020"], count: 1 } }));
    const res = await sendGuarded(failing, [{ from: "Story", update: { Estimate: 2 } }]);
    expect(res.conflicts).toEqual([]);
    expect(res.failures).toHaveLength(1);
    const conflicting = fakeTransport(PROJECTED.slice(0, 2), stamps, envelope({ assetsModified: { oidTokens: ["Story:146020"], count: 1 } }));
    const error = (await sendGuarded(conflicting, [{ from: "Story", update: { Estimate: 2 } }], { throwOnFailure: true }).catch((e: unknown) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ kind: "conflict", code: "CONFLICT", conflicts: ["Story:146021"], result: { modified: ["Story:146020"] } });
    expect(error.message).toBe("Story:146021 changed since it was read; nothing was applied to it");
  });

  it("moments the caller holds are used as given and not read again; only the other assets' are read", async () => {
    const t = fakeTransport(PROJECTED.slice(0, 2), envelope({ queryResult: { results: [[{ _oid: "Story:146021", Moment: "196333" }]], resultMetaData: [], count: 1 } }), envelope({ assetsModified: { oidTokens: ["Story:146020"], count: 1 }, assetsOperatedOn: { oidTokens: ["Story:146021"], count: 1 } }));
    const res = await sendGuarded(t, [{ from: "Story", update: { Estimate: 2 } }], { moments: { "Story:146020:999": 196000, "Story:5": "1" } });
    expect((t.calls[1]!.body as { with: unknown }[])[0]!.with).toEqual({ $oids: ["Story:146021"] });
    expect(res.details.stamps).toEqual({ "Story:146020": "196000", "Story:146021": "196333" });
    expect((t.calls[2]!.body as { with: unknown }[])[0]!.with).toEqual({ $oid: "Story:146020", $moment: "196000" });
    expect(res.conflicts).toEqual([]);
    // Every asset supplied: no read at all.
    const none = fakeTransport(PROJECTED.slice(0, 1), envelope({ assetsModified: { oidTokens: ["Story:146020"], count: 1 } }));
    await sendGuarded(none, [{ from: "Story:146020", update: { Estimate: 2 } }], { moments: { "Story:146020": "196330" } });
    expect(none.calls).toHaveLength(2);
  });

  it("a guarded batch with a create is not marked idempotent — a resend would create twice", async () => {
    const t = fakeTransport(PROJECTED, envelope({ queryResult: { results: [[{ _oid: "Story:146020", Moment: "196330" }, { _oid: "Story:146021", Moment: "196333" }]], resultMetaData: [], count: 2 } }), envelope());
    await sendGuarded(t, [{ from: "Story", update: { Estimate: 2 } }]);
    expect(t.calls[2]!.idempotent).toBe(false);
  });

  it("refuses an unguardable batch before any request, and anything of the Ideas product, which has no Moment", async () => {
    const none = fakeTransport();
    await expect(sendGuarded(none, [{ "@u": { from: "Story:1", update: { Name: "x" } } }])).rejects.toBeInstanceOf(UnguardableError);
    expect(none.calls).toHaveLength(0);
    const ideas = fakeTransport([{ "@x": { oid: "Idea:7", update: { Name: { add: ["y"], remove: [] } } } }]);
    await expect(sendGuarded(ideas, [{ from: "Idea:7", update: { Name: "y" } }])).rejects.toMatchObject({ reasons: [{ index: -1, code: "noMoment" }] });
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

  it("the second pass goes only for assets whose first command applied, guarded on the Moment read just after it", async () => {
    const sent: unknown[][] = [];
    const transport = { request: vi.fn(async (o: { body: unknown[] }) => {
      const body = o.body as Record<string, unknown>[];
      if (body.length === 1 && (body[0]!.select as string[] | undefined)?.[0] === "Moment") return env({ queryResult: { results: [[{ _oid: "Story:1", Moment: "501" }]], resultMetaData: [], count: 1 } });
      sent.push(body);
      // Pass 1: Story:1 applies, Story:2 was changed by someone else and matches nothing.
      return sent.length === 1 ? env({ assetsOperatedOn: { oidTokens: ["Story:1:77"], count: 1 } }) : env({ assetsOperatedOn: { oidTokens: ["Story:1"], count: 1 } });
    }) } as unknown as Parameters<typeof sendPasses>[0];
    const projected = [P("Story:1", { execute: { op: "Reactivate", args: {} } }), P("Story:2", { execute: { op: "Reactivate", args: {} } }), P("Story:1", { execute: { op: "Delete", args: {} } }), P("Story:2", { execute: { op: "Delete", args: {} } })];
    const r = await sendPasses(transport, projected, { "Story:1": "101", "Story:2": "102" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([{ from: "Story", where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"], with: { $oid: "Story:1", $moment: "501" }, execute: { op: "Delete", args: {} } }]); // Story:2's Delete never sent
    expect(r.sent).toHaveLength(3);
    expect(r.outcome.operated).toEqual(["Story:1", "Story:1"]);
    // Two sends: no one request id stands for the batch. One send keeps its own.
    expect(r.outcome.requestId).toBeNull();
    const once = await sendPasses(transport, [P("Story:1", { execute: { op: "Reactivate", args: {} } })], { "Story:1": "101" });
    expect(once.outcome.requestId).toBe("r");
  });
});
