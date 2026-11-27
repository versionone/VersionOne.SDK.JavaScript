import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { ApiError } from "../../src/core/errors";
import { validValues } from "../../src/wire";
import { deleteFixtures, describeInstance, fixtureName, instance, sendFixtures } from "./instance";
import { reference, schemeStatuses } from "./referenceData";

/**
 * Valid values against a real instance: what api/ValidValues answers for a
 * list-typed attribute, and client.lists over it. The suite brings a whole
 * small world of its own, so every expectation is exact, and touches
 * nothing that exists:
 *   - a Scope under the system project with its own Scheme;
 *   - two global statuses, one selected in that Scheme and one in none;
 *     two priorities likewise;
 *   - a Team that owns three statuses (one of them inactivated), which
 *     gives it a process of its own, and a Team that owns none;
 *   - a Story on each team and one on no team.
 * Each "these values" has a control beside it that must not appear. All
 * of it is deleted by exact OID, dependents first, and the suite fails if
 * any of it can still be read. The Scope lives for seconds and no member
 * is assigned to it, so nothing can come to reference it as a default
 * project; that is not checked.
 */
describeInstance("valid values (live)", () => {
  const t = instance!.transport;
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
  const created: string[] = [];
  const made: Record<string, string> = {};
  /** A fixture's OID by the key it was made under. */
  const o = new Proxy(made, { get: (target, key) => { const oid = target[String(key)]; if (!oid) throw new Error(`no fixture ${String(key)}`); return oid; } }) as Record<string, string> & { [key: string]: string };
  const make = async (commands: Record<string, Record<string, unknown>>) => {
    const oids = (await sendFixtures(t, Object.values(commands) as never)).assetsCreated!.oidTokens;
    Object.keys(commands).forEach((key, i) => { made[key] = oids[i]!; });
    created.push(...oids);
  };
  const names = (rows: { Name: string }[]) => rows.map((r) => r.Name);
  const n = (what: string) => fixtureName(`values ${what}`);
  const label: Record<string, string> = {};
  const named = (key: string, what: string) => (label[key] = n(what));

  beforeAll(async () => {
    await make({ team: { AssetType: "Team", Name: n("team with a process") }, plainTeam: { AssetType: "Team", Name: n("team without") }, priorityTeam: { AssetType: "Team", Name: n("team that owns a priority") }, scheme: { AssetType: "Scheme", Name: n("scheme"), IsRequiredAtClose: false } });
    await make({ scope: { AssetType: "Scope", Name: n("scope"), Parent: "Scope:0", Scheme: o["scheme"]!, BeginDate: "2026-01-01" } });
    await make({
      inScheme: { AssetType: "StoryStatus", Name: named("inScheme", "status in scheme"), RollupState: "Active", SelectedInSchemes: [o["scheme"]!] },
      notInScheme: { AssetType: "StoryStatus", Name: named("notInScheme", "status in no scheme"), RollupState: "Active" },
      teamFirst: { AssetType: "StoryStatus", Name: named("teamFirst", "team status first"), RollupState: "Active", Team: o["team"]! },
      teamSecond: { AssetType: "StoryStatus", Name: named("teamSecond", "team status second"), RollupState: "Closed", Team: o["team"]! },
      teamInactive: { AssetType: "StoryStatus", Name: named("teamInactive", "team status inactive"), RollupState: "Active", Team: o["team"]! },
      priority: { AssetType: "WorkitemPriority", Name: named("priority", "priority in scheme"), SelectedInSchemes: [o["scheme"]!] },
      otherPriority: { AssetType: "WorkitemPriority", Name: named("otherPriority", "priority in no scheme") },
      teamPriority: { AssetType: "WorkitemPriority", Name: named("teamPriority", "priority owned by a team"), Team: o["priorityTeam"]! }
    });
    await client.send([{ from: o["teamInactive"]!, execute: "Inactivate" }], { throwOnFailure: true });
    await make({
      onTeam: { AssetType: "Story", Name: n("story on the team"), Scope: o["scope"]!, Team: o["team"]! },
      noTeam: { AssetType: "Story", Name: n("story on no team"), Scope: o["scope"]! },
      onPlainTeam: { AssetType: "Story", Name: n("story on the plain team"), Scope: o["scope"]!, Team: o["plainTeam"]! },
      onPriorityTeam: { AssetType: "Story", Name: n("story on the team that owns a priority"), Scope: o["scope"]!, Team: o["priorityTeam"]! }
    });
  }, 120_000);

  afterAll(async () => {
    const rank = (oid: string) => ["Story", "StoryStatus", "WorkitemPriority", "Scope", "Scheme", "Team"].indexOf(oid.split(":")[0]!);
    await deleteFixtures(t, [...created].sort((a, b) => rank(a) - rank(b)));
    // Deleted means unreadable: a Delete that answered success and left the asset would be a leak.
    for (const type of new Set(created.map((oid) => oid.split(":")[0]!))) {
      const oids = created.filter((oid) => oid.startsWith(`${type}:`));
      const left = await client.query({ from: type, select: ["Name"], filter: ["ID=$oids"], with: { $oids: oids }, page: { size: oids.length, start: 0 } });
      if (left.length) throw new Error(`fixtures left behind: ${left.map((r) => r._oid).join(", ")}`);
    }
  }, 120_000);

  it("a team that owns a status has a process of its own; one that owns none has not", async () => {
    const teams = await client.query<{ _oid: string; HasProcess: unknown }>({ from: "Team" as never, select: ["HasProcess"], filter: ["ID=$oids"], with: { $oids: [o["team"]!, o["plainTeam"]!] }, sort: ["ID"], page: { size: 2, start: 0 } });
    expect(teams.map((r) => [r._oid, String(r.HasProcess).toLowerCase()])).toEqual([[o["team"]!, "true"], [o["plainTeam"]!, "false"]]);
  });

  it("the scope's scheme decides: only the values selected in it, for Status and for Priority alike; a base type is a type", async () => {
    const answer = await client.lists.values({ type: "Story", scope: o["scope"]!, attributes: ["Status", "Priority"] });
    expect(answer).toEqual({ Status: [{ _oid: o["inScheme"]!, Name: label["inScheme"]! }], Priority: [{ _oid: o["priority"]!, Name: label["priority"]! }] });
    expect(await client.lists.values({ type: "PrimaryWorkitem", scope: o["scope"]!, attributes: ["Status"] })).toEqual({ Status: [{ _oid: o["inScheme"]!, Name: label["inScheme"]! }] });
    // Control: another scope has none of these.
    const system = await client.lists.values({ type: "Story", scope: "Scope:0", attributes: ["Status", "Priority"] });
    for (const rows of Object.values(system)) for (const oid of created) expect(rows.map((r) => r._oid)).not.toContain(oid);
  });

  it("a team with its own process replaces the scheme's statuses with its own, an inactive one left out, in Order; the asset alone says so", async () => {
    const forAsset = await client.lists.values({ asset: o["onTeam"]!, attributes: ["Status", "Priority"], select: ["Order"] });
    expect(names(forAsset.Status!)).toEqual([label["teamFirst"]!, label["teamSecond"]!]);
    expect(forAsset.Status!.map((r) => Number(r.Order))).toEqual([...forAsset.Status!.map((r) => Number(r.Order))].sort((a, b) => a - b));
    // The endpoint sends every value as a string; the row has a number as a number, like any read.
    expect(typeof forAsset.Status![0]!.Order).toBe("number");
    const asRead = await client.query<{ _oid: string; Order: unknown }>({ from: "StoryStatus" as never, select: ["Order"], filter: ["ID=$oid"], with: { $oid: forAsset.Status![0]!._oid }, page: { size: 1, start: 0 } });
    expect(forAsset.Status![0]!.Order).toBe(asRead[0]!.Order);
    // This team owns statuses and no priority, so its statuses replace the scheme's and Priority still comes from the scheme.
    expect(names(forAsset.Priority!)).toEqual([label["priority"]!]);
    // RollupState is selectable on a status.
    expect((await client.lists.values({ asset: o["onTeam"]!, attributes: ["Status"], select: ["RollupState"] })).Status!.map((r) => r.RollupState)).toEqual(["Active", "Closed"]);
    // No team, or a team that owns no status: the scheme's.
    expect(names((await client.lists.values({ asset: o["noTeam"]!, attributes: ["Status"] })).Status!)).toEqual([label["inScheme"]!]);
    expect(names((await client.lists.values({ asset: o["onPlainTeam"]!, attributes: ["Status"] })).Status!)).toEqual([label["inScheme"]!]);
  });

  it("the team's own values replace the scheme's for ANY list, not only Status: a team that owns a priority is offered that, and its Status still comes from the scheme; team: null asks as if on no team", async () => {
    const offered = await client.lists.values({ asset: o["onPriorityTeam"]!, attributes: ["Priority", "Status"], select: ["Team"] });
    expect(offered.Priority).toEqual([{ _oid: o["teamPriority"]!, Name: label["teamPriority"]!, Team: { _oid: o["priorityTeam"]! } }]);
    // A relation that is empty is null, as on any read.
    expect(offered.Status).toEqual([{ _oid: o["inScheme"]!, Name: label["inScheme"]!, Team: null }]);
    // As if on no team: the scheme's priority.
    expect(names((await client.lists.values({ asset: o["onPriorityTeam"]!, team: null, attributes: ["Priority"] })).Priority!)).toEqual([label["priority"]!]);
    expect(names((await client.lists.values({ asset: o["onTeam"]!, team: null, attributes: ["Status"] })).Status!)).toEqual([label["inScheme"]!]);
    // And the owning team's priority is offered to nobody else.
    expect(names((await client.lists.values({ asset: o["noTeam"]!, attributes: ["Priority"] })).Priority!)).toEqual([label["priority"]!]);
  });

  it("an empty answer can be the server giving up, not 'nothing is valid': with no scope in the context the endpoint answers 200 and no values", async () => {
    // Why the service always sends a scope, and refuses a type whose rule needs more than that without it.
    const empty = await t.request<{ total: number; Assets: unknown[] }>({ method: "GET", path: "/api/ValidValues/Story.Status/?context=&sel=Name", headers: { accept: "application/json" }, responseType: "json" });
    expect(empty).toMatchObject({ total: 0, Assets: [] });
    // Control: the same request with the scope has the value.
    expect((await client.lists.values({ type: "Story", scope: o["scope"]!, attributes: ["Status"] })).Status).toHaveLength(1);
    // A sort the list type has no attribute for is ignored without an error: the default order comes back.
    const ignored = await t.request<{ Assets: { id: string }[] }>({ method: "GET", path: `/api/ValidValues/Story/${o["onTeam"]!.split(":")[1]}/Status?sel=Name&sort=Nmae`, headers: { accept: "application/json" }, responseType: "json" });
    expect(ignored.Assets.map((a) => a.id)).toEqual([o["teamFirst"]!, o["teamSecond"]!]);
  });

  it("for an asset not created yet the team travels in the context: with a process its statuses, without one the scheme's; and an asset can be asked about as if on a team", async () => {
    expect(names((await client.lists.values({ type: "Story", scope: o["scope"]!, team: o["team"]!, attributes: ["Status"] })).Status!)).toEqual([label["teamFirst"]!, label["teamSecond"]!]);
    expect(names((await client.lists.values({ type: "Story", scope: o["scope"]!, team: o["plainTeam"]!, attributes: ["Status"] })).Status!)).toEqual([label["inScheme"]!]);
    expect(names((await client.lists.values({ type: "Story", scope: o["scope"]!, team: o["team"]!, attributes: ["Priority"] })).Priority!)).toEqual([label["priority"]!]);
    expect(names((await client.lists.values({ asset: o["noTeam"]!, team: o["team"]!, attributes: ["Status"] })).Status!)).toEqual([label["teamFirst"]!, label["teamSecond"]!]);
    // Why the SDK does not send `teamoid` in the relation form: the server ignores it there and answers the scheme's values.
    const ignored = await t.request<{ Assets: { id: string }[] }>({ method: "GET", path: `/api/ValidValues/Story.Status/?context=Scope=${o["scope"]!}&teamoid=${o["team"]!}&sel=Name`, headers: { accept: "application/json" }, responseType: "json" });
    expect(ignored.Assets.map((a) => a.id)).toEqual([o["inScheme"]!]);
  });

  it("value resolves a name there, and says what the valid values are when it is none of them", async () => {
    expect(await client.lists.value({ asset: o["onTeam"]!, attribute: "Status", name: `  ${label["teamSecond"]!.toUpperCase()} ` })).toEqual({ _oid: o["teamSecond"]!, Name: label["teamSecond"]! });
    expect(await client.lists.value({ asset: o["onTeam"]!, attribute: "Status", name: o["teamFirst"]! })).toMatchObject({ _oid: o["teamFirst"]! });
    // A status of the scheme is not valid on the team's story; the inactive one is not valid anywhere.
    for (const name of [label["inScheme"]!, o["inScheme"]!, label["teamInactive"]!]) {
      const error = await client.lists.value({ asset: o["onTeam"]!, attribute: "Status", name }).catch((e: unknown) => e as ApiError);
      expect(error).toMatchObject({ code: "NO_SUCH_VALUE", details: { values: [{ _oid: o["teamFirst"]!, Name: label["teamFirst"]! }, { _oid: o["teamSecond"]!, Name: label["teamSecond"]! }] } });
    }
    // Both team statuses begin "sdk-integration": a prefix that fits both is ambiguous, never a pick.
    await expect(client.lists.value({ asset: o["onTeam"]!, attribute: "Status", name: "sdk-integration", match: "prefix" })).rejects.toMatchObject({ code: "AMBIGUOUS_VALUE" });
  });

  it("the server enforces the team's process on a write, and not the scope's scheme: the list is what to offer, not what the server will refuse", async () => {
    const refused = await client.send([{ from: o["onTeam"]!, update: { Status: o["inScheme"]! } }]);
    expect(refused.modified).toEqual([]);
    expect(refused.failures[0]!.message).toBe("Violation'PrimaryWorkitemCannotHaveInvalidStatus");
    // A status selected in no scheme, on a story whose team has no process: accepted.
    const accepted = await client.send([{ from: o["noTeam"]!, update: { Status: o["notInScheme"]! } }]);
    expect(accepted.modified).toEqual([o["noTeam"]!]);
    expect(accepted.failures).toEqual([]);
    await client.send([{ from: o["noTeam"]!, update: { Status: null } }], { throwOnFailure: true });
  });

  // What the server accepts here is what it accepted when this was written, not a promise: the product has added enforcement
  // over time. If a release starts refusing one of the "accepted" cases, that is the server getting stricter, not a fault in
  // the SDK: change the expectation and the README's "Resolve before you write" with it.
  it("on a write, only a story's or defect's Status is checked, and only against the team: any other list value is accepted wherever it comes from", async () => {
    const set = async (story: string, update: Record<string, string | null>) => { const done = await client.send([{ from: story, update }]); return done.failures.length ? done.failures[0]!.message : "accepted"; };
    // Priority, three ways the list says are not valid: the scheme's on a story whose team owns a priority, a team's on a story on no team, one in no scheme.
    expect(await set(o["onPriorityTeam"]!, { Priority: o["priority"]! })).toBe("accepted");
    expect(await set(o["noTeam"]!, { Priority: o["teamPriority"]! })).toBe("accepted");
    expect(await set(o["noTeam"]!, { Priority: o["otherPriority"]! })).toBe("accepted");
    // Status against the team, both ways round: a team's status on a story not on that team, and a global one on a story whose team has its own.
    expect(await set(o["noTeam"]!, { Status: o["teamFirst"]! })).toBe("Violation'PrimaryWorkitemCannotHaveInvalidStatus");
    expect(await set(o["onPlainTeam"]!, { Status: o["teamFirst"]! })).toBe("Violation'PrimaryWorkitemCannotHaveInvalidStatus");
    expect(await set(o["onTeam"]!, { Status: o["notInScheme"]! })).toBe("Violation'PrimaryWorkitemCannotHaveInvalidStatus");
    // An inactive status of the story's own team is not offered, and is accepted.
    expect(await set(o["onTeam"]!, { Status: o["teamInactive"]! })).toBe("accepted");
    await client.send([{ from: o["onTeam"]!, update: { Status: null } }, { from: o["noTeam"]!, update: { Priority: null } }, { from: o["onPriorityTeam"]!, update: { Priority: null } }], { throwOnFailure: true });
  });

  it("a status that stops being valid when a story moves is cleared without a word: the scheme is applied on a move, not on setting a status", async () => {
    const status = async (story: string) => (await client.get<{ _oid: string; Status: { _oid: string } | null }>(story, ["Status"]))!.Status?._oid ?? null;
    // On no team, with a status the scheme does not select (accepted, as above).
    await client.send([{ from: o["noTeam"]!, update: { Status: o["notInScheme"]! } }], { throwOnFailure: true });
    expect(await status(o["noTeam"]!)).toBe(o["notInScheme"]!);
    // Moved onto a team (one that owns no status): the write succeeds, and the status is gone.
    const moved = await client.send([{ from: o["noTeam"]!, update: { Team: o["plainTeam"]! } }]);
    expect(moved).toMatchObject({ modified: [o["noTeam"]!], failures: [] });
    expect(await status(o["noTeam"]!)).toBeNull();
    // Control: a status the scheme selects survives the same kind of move.
    await client.send([{ from: o["noTeam"]!, update: { Status: o["inScheme"]! } }], { throwOnFailure: true });
    await client.send([{ from: o["noTeam"]!, update: { Team: null } }], { throwOnFailure: true });
    expect(await status(o["noTeam"]!)).toBe(o["inScheme"]!);
    await client.send([{ from: o["noTeam"]!, update: { Status: null } }], { throwOnFailure: true });
  });

  it("what the service refuses to ask, and why: the endpoint answers any relation whole. The raw module shows it on a relation this suite can bound", async () => {
    await expect(client.lists.values({ asset: o["onTeam"]!, attributes: ["Team"] })).rejects.toMatchObject({ kind: "usage" });
    // An attribute the type does not have: the server's answer is a bare 400, so the service says it first.
    await expect(validValues.forNew(t, "Story", "Nmae", o["scope"]!)).rejects.toMatchObject({ status: 400 });
    await expect(client.lists.values({ type: "Story", scope: o["scope"]!, attributes: ["Nmae"] })).rejects.toMatchObject({ kind: "usage" });
    // The context takes a scope and a team joined by a comma, and nothing else.
    await expect(t.request({ method: "GET", path: `/api/ValidValues/Story.Status/?context=Scope=${o["scope"]!};Team=${o["team"]!}&sel=Name`, headers: { accept: "application/json" }, responseType: "json" })).rejects.toMatchObject({ status: 400 });
  });

  it("the permanent reference team (AGENTS.md) offers its three statuses, in Order, to a story on it; read only, and skipped where the instance has no such team", async (context) => {
    const [team] = await client.query<{ _oid: string; Name: string }>({ from: "Team" as never, select: ["Name"], filter: ["ID=$oid"], with: { $oid: reference.team }, page: { size: 1, start: 0 } });
    if (team?.Name !== "sdk-reference team") return context.skip();
    const offered = await client.lists.values({ type: "Story", scope: o["scope"]!, team: reference.team, attributes: ["Status"], select: ["RollupState"] });
    expect(offered.Status).toEqual([
      { _oid: reference.ready, Name: "sdk-reference Ready", RollupState: "Future" },
      { _oid: reference.inProgress, Name: "sdk-reference In Progress", RollupState: "Active" },
      { _oid: reference.done, Name: "sdk-reference Done", RollupState: "Closed" }
    ]);
    expect(await client.lists.value({ type: "Story", scope: o["scope"]!, team: reference.team, attribute: "Status", name: "sdk-reference done" })).toMatchObject({ _oid: reference.done });
    // The suite's own team is not offered them, and they are not this suite's to delete.
    expect((await client.lists.values({ asset: o["onTeam"]!, attributes: ["Status"] })).Status!.map((r) => r._oid)).not.toContain(reference.done);
    expect(created).not.toContain(reference.team);
  });

  it("the permanent statuses selected in the default scheme (AGENTS.md) are what a story in the system project on no team is offered; read only, and skipped where the instance has none", async (context) => {
    const present = await client.query({ from: "StoryStatus" as never, select: ["Name"], filter: ["ID=$oids"], with: { $oids: schemeStatuses.map((s) => s._oid) }, page: { size: 5, start: 0 } });
    if (present.length !== schemeStatuses.length) return context.skip();
    // RollupState is what tells a consumer that "Done" closes work.
    const offered = await client.lists.values({ type: "Story", scope: "Scope:0", attributes: ["Status"], select: ["RollupState"] });
    expect(offered.Status).toEqual(schemeStatuses.map((s) => ({ ...s })));
    expect(await client.lists.value({ type: "Story", scope: "Scope:0", attribute: "Status", name: "done" })).toEqual({ _oid: "StoryStatus:152570", Name: "Done" });
    // "In Progress" and the reference team's "sdk-reference In Progress" are different lists: each context has its own.
    expect(await client.lists.value({ type: "Story", scope: "Scope:0", attribute: "Status", name: "in progress" })).toMatchObject({ _oid: "StoryStatus:152568" });
    await expect(client.lists.value({ type: "Story", scope: "Scope:0", team: reference.team, attribute: "Status", name: "in progress" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE" });
    // The suite's own scope has its own scheme, so it is offered none of them.
    expect((await client.lists.values({ asset: o["noTeam"]!, attributes: ["Status"] })).Status!.map((r) => r._oid)).not.toContain("StoryStatus:152570");
  });

  it("fields.describe says which of a form's attributes are list-typed", async () => {
    const described = await client.fields.describe("Story", o["scope"]!);
    expect(described.lists).toMatchObject({ Status: "StoryStatus", Priority: "WorkitemPriority" });
    expect(described.lists).not.toHaveProperty("Owners");
    expect(described.lists).not.toHaveProperty("Name");
  });
});
