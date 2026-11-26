import { describe, expect, it, vi } from "vitest";
import { ApiError, UsageError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { explain } from "../../src/services/explain";
import { FakeAgilityClient } from "../../src/testing";
import { parseViolation } from "../../src/types/command";

/**
 * An error, said to a person. The failure messages and loc-2's answers are
 * copied from the API-testing instance (2026-11-26).
 */
const LOC2: Record<string, string> = {
  "Violation'Required'AttributeDefinition'Scope'Story": "Agility Warning: The attribute Project is required and was not supplied. This change was not saved. Please alert your administrator if you continue to have an issue.",
  "AttributeDefinition'Scope'Story": "Project",
  "AssetType'Story": "Backlog Item",
  "Violation'AssetCannotDeleteClosed": "Agility Warning: Attempting to delete a closed item.  This change was not saved."
};
function loc2(): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  // loc-2 answers a tag it does not know with the tag itself.
  const request = vi.fn(async (o: RequestOptions) => { calls.push(o); const tags = JSON.parse(decodeURIComponent(o.path.slice(o.path.indexOf("?") + 1))) as string[]; return Object.fromEntries(tags.map((t) => [t, LOC2[t] ?? t])); });
  return { request: request as Transport["request"], calls };
}
const failure = (index: number, message: string) => ({ index, message, violation: parseViolation(message), echoed: {} });

describe("explain", () => {
  it("says each failed command in a sentence, with the instance's labels, from one loc-2 request", async () => {
    const t = loc2();
    const explained = await explain(t, [
      failure(0, "Violation'Required'AttributeDefinition'Scope'Story"),
      failure(1, "Resolution'Unresolved'Story.Status'StoryStatus"),
      failure(2, "Input string was not in a correct format."),
      failure(3, "Violation'Invalid'Story.Owners"),
      failure(4, "Violation'AssetCannotDeleteClosed")
    ]);
    expect(t.calls).toHaveLength(1);
    expect(explained.map((e) => e.sentence)).toEqual([
      "Project is required.",
      "Status: no StoryStatus matches the value given.",
      "Input string was not in a correct format.",
      "Owners is not valid.",
      "Agility Warning: Attempting to delete a closed item.  This change was not saved."
    ]);
    expect(explained[0]).toEqual({
      sentence: "Project is required.", audience: "user", echoed: false, index: 0, rule: "Required", attribute: "Story.Scope", attributeLabel: "Project", typeLabel: "Backlog Item", relatedType: null, relatedTypeLabel: null,
      localized: LOC2["Violation'Required'AttributeDefinition'Scope'Story"], message: "Violation'Required'AttributeDefinition'Scope'Story"
    });
    // A Resolution failure names the attribute as a token and then the related type; loc-2 has no label for these here, so their own names stand in.
    expect(explained[1]).toMatchObject({ rule: "Unresolved", attribute: "Story.Status", attributeLabel: "Status", typeLabel: "Backlog Item", relatedType: "StoryStatus", relatedTypeLabel: "StoryStatus", localized: null });
    // A plain sentence is not a tag: nothing is asked about it and nothing is invented.
    expect(explained[2]).toMatchObject({ rule: null, attribute: null, attributeLabel: null, localized: null });
    expect(explained[4]).toMatchObject({ rule: "AssetCannotDeleteClosed", attribute: null });
    // Who each sentence is for: the ones made for a person, and the server's raw text, which is echoed for a developer.
    expect(explained.map((e) => [e.audience, e.echoed])).toEqual([["user", false], ["user", false], ["developer", true], ["user", false], ["user", false]]);
    // A rule the instance has no words for (seen live: closing a closed story) is never answered as its bare token.
    expect((await explain(loc2(), [failure(0, "Violation'AssetCannotInactivateClosed")]))[0]).toMatchObject({ sentence: "Refused (asset cannot inactivate closed).", audience: "user", echoed: false, rule: "AssetCannotInactivateClosed", localized: null, message: "Violation'AssetCannotInactivateClosed" });
    // A Resolution failure names the related type, labelled when the instance has a label for it.
    const labelled = loc2();
    LOC2["AssetType'Member"] = "Member";
    LOC2["AttributeDefinition'Owners'Story"] = "Owner";
    try {
      expect((await explain(labelled, [failure(0, "Resolution'Ambiguous'Story.Owners'Member")]))[0]).toMatchObject({ sentence: "Owner: more than one Member matches the value given.", rule: "Ambiguous", attribute: "Story.Owners", relatedType: "Member", relatedTypeLabel: "Member" });
    } finally { delete LOC2["AssetType'Member"]; delete LOC2["AttributeDefinition'Owners'Story"]; }
  });

  it("takes an Outcome, a CommandFailureError or its failures alike; no failures, no request", async () => {
    const fake = new FakeAgilityClient().onLocalize(LOC2).onSend({ failures: [{ index: 0, message: "Violation'Required'AttributeDefinition'Scope'Story" }] });
    const outcome = await fake.send([{ AssetType: "Story", Name: "x" }]);
    const thrown = await fake.send([{ AssetType: "Story", Name: "x" }], { throwOnFailure: true }).catch((e: unknown) => e);
    for (const input of [outcome, thrown, outcome.failures]) expect((await fake.explain(input)).map((e) => e.sentence)).toEqual(["Project is required."]);
    const t = loc2();
    expect(await explain(t, { failures: [] })).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it("an error that is not about commands gets one sentence by its kind, and no request; a label that cannot be fetched never becomes an error", async () => {
    const t = loc2();
    const say = async (e: unknown) => (await explain(t, e))[0]!.sentence;
    expect(await say(new ApiError("Unauthorized", 401))).toBe("Agility did not accept the sign-in: the token is missing, wrong or no longer valid.");
    expect(await say(new ApiError("Forbidden", 403))).toBe("Agility refused: this member is not allowed to do that.");
    expect(await say(new ApiError("fetch failed", 0, "NETWORK_ERROR"))).toBe("Agility could not be reached, or is busy. The same request may work in a moment.");
    expect(await say(new ApiError("Request aborted", 0, "ABORTED"))).toBe("The request was cancelled.");
    // The SDK's own sentences and the server's (a rejected query) are said as they are.
    expect(await say(new UsageError("query of Story without a page: every read must be bounded"))).toBe("query of Story without a page: every read must be bounded");
    expect(await say(new ApiError("Invalid WHERE parameter; Invalid QueryFilter2 token Nope=1", 400, "QUERY_REJECTED"))).toBe("Invalid WHERE parameter; Invalid QueryFilter2 token Nope=1");
    expect(await say(new Error("boom"))).toBe("boom");
    // A consumer can call explain on anything and show only what is for a user: a developer's message is passed through and marked.
    const about = async (e: unknown) => { const x = (await explain(t, e))[0]!; return [x.audience, x.echoed]; };
    for (const e of [new ApiError("Unauthorized", 401), new ApiError("down", 503), new ApiError("x", 200, "CONFLICT")]) expect(await about(e)).toEqual(["user", false]);
    for (const e of [new UsageError("query of Story without a page"), new ApiError("Invalid WHERE parameter", 400, "QUERY_REJECTED"), new ApiError("not JSON", 200, "BAD_JSON"), new Error("boom")]) expect(await about(e)).toEqual(["developer", true]);
    expect(t.calls).toHaveLength(0);
    const down: Transport = { request: async () => { throw new ApiError("down", 503); } };
    expect((await explain(down, [failure(0, "Violation'Required'AttributeDefinition'Scope'Story")]))[0]).toMatchObject({ sentence: "Scope is required.", attributeLabel: "Scope", typeLabel: "Story", localized: null });
  });
});
