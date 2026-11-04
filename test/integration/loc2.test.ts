import { expect, it } from "vitest";
import { localize } from "../../src/wire/loc2";
import { describeInstance, instance } from "./instance";

/**
 * loc-2.v1 against a real instance. Read-only. What the fakes cannot prove:
 * that the quoting survives the server's LSON parser, that GET and POST
 * agree, and that an unmatched tag really comes back as itself.
 */
describeInstance("loc2 (live)", () => {
  const t = instance!.transport;
  const tags = ["Scope", "Plural'Story", "AttributeDefinition'Name'Story", "a, b", "x]y", 'say "hi"', "café — ok"];

  it("every tag comes back keyed exactly as sent; tagged terms resolve to labels, and an unmatched tag to itself — the expect-zero control", async () => {
    const out = await localize(t, [...tags, "sdk-integration no such tag"]);
    expect(Object.keys(out).sort()).toEqual([...tags, "sdk-integration no such tag"].sort());
    expect(out["sdk-integration no such tag"]).toBe("sdk-integration no such tag");
    expect(out["a, b"]).toBe("a, b");
    // Resolved terms differ from their tags; the exact words are the instance's terminology.
    expect(out["AttributeDefinition'Name'Story"]).not.toBe("AttributeDefinition'Name'Story");
    expect(out["Plural'Story"]).not.toBe("Plural'Story");
  });

  it("a POST of the same list answers the same as the GET", async () => {
    const viaGet = await localize(t, tags);
    const viaPost = await localize(t, tags, { maxGetLength: 0 });
    expect(viaPost).toEqual(viaGet);
  });
});
