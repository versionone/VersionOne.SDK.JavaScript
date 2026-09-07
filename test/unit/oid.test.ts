import { describe, expect, it } from "vitest";
import { isOidToken, momentless, parseOid, toOid, typeOfOid } from "../../src/types/oid";

describe("oid", () => {
  it("recognises OID tokens with and without a moment, and nothing else", () => {
    expect(isOidToken("Story:1234")).toBe(true);
    expect(isOidToken("Story:1234:5678")).toBe(true);
    expect(isOidToken("Custom_Thing:1")).toBe(true);
    for (const not of ["S-1234", "Story", "Story:", "Story:abc", ":12", "@story", "", 12, null, undefined, { _oid: "Story:1" }]) expect(isOidToken(not)).toBe(false);
  });

  it("parses a token into type, id and moment, and rebuilds it", () => {
    expect(parseOid("Story:1234")).toEqual({ type: "Story", id: 1234, moment: null });
    expect(parseOid("Story:1234:5678")).toEqual({ type: "Story", id: 1234, moment: 5678 });
    expect(toOid("Story", 1234)).toBe("Story:1234");
    expect(toOid("Story", 1234, 5678)).toBe("Story:1234:5678");
    expect(typeOfOid("Epic:7:9")).toBe("Epic");
    expect(() => parseOid("S-1234")).toThrow(/not an OID token/);
  });

  it("momentless strips the moment and leaves a non-token alone", () => {
    expect(momentless("Story:1234:5678")).toBe("Story:1234");
    expect(momentless("Story:1234")).toBe("Story:1234");
    expect(momentless("NULL")).toBe("NULL");
    expect(momentless("@story")).toBe("@story");
  });
});
