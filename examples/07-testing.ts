/**
 * Testing code that uses the SDK, with no instance: FakeAgilityClient is a
 * real client over a transport that sends nothing and answers what the
 * test scripted. Needs no credentials and no network.
 *
 *   node examples/07-testing.ts
 */
import assert from "node:assert/strict";
import type { AgilityApiClient } from "@versionone/agility-sdk";
import { FakeAgilityClient } from "@versionone/agility-sdk/testing";

// The code under test: yours. It takes a client, so a test can hand it the fake.
async function closeIfEstimated(client: AgilityApiClient, oid: string): Promise<"closed" | "needs an estimate" | "changed by someone else"> {
  const story = await client.get(oid, ["Estimate", "Moment"]);
  if (story?.Estimate == null) return "needs an estimate";
  const result = await client.sendGuarded([{ from: oid, execute: "QuickClose" }], { moments: { [oid]: String(story.Moment) } });
  return result.conflicts.length ? "changed by someone else" : "closed";
}

// It closes an estimated story, and what it sent is on the fake.
{
  const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:1", Name: "Logon", Estimate: 2 }]);
  assert.equal(await closeIfEstimated(fake, "Story:1"), "closed");
  assert.equal(fake.sent.length, 1);                                  // one batch was sent,
  assert.match(JSON.stringify(fake.sent[0]), /Story:1.*QuickClose/);  // as the guard wrote it for the server
}

// It leaves an unestimated story alone: nothing was sent.
{
  const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:2", Name: "Logoff", Estimate: null }]);
  assert.equal(await closeIfEstimated(fake, "Story:2"), "needs an estimate");
  assert.equal(fake.sent.length, 0);
}

// Someone else changes the story between the read and the write: `touch`
// is that other writer, and the guarded write is a conflict.
{
  const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:3", Name: "Search", Estimate: 5 }]);
  const racing = new Proxy(fake, { get: (target, key) => key === "sendGuarded"
    ? (...args: Parameters<AgilityApiClient["sendGuarded"]>) => { target.touch("Story:3"); return target.sendGuarded(...args); }
    : Reflect.get(target, key) });
  assert.equal(await closeIfEstimated(racing, "Story:3"), "changed by someone else");
}

// A read nothing was scripted for throws; it never looks like an empty result.
await assert.rejects(new FakeAgilityClient().query({ from: "Defect", select: ["Name"], page: { size: 1, start: 0 } }));

console.log("all four checks passed");
