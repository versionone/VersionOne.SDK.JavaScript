import { describe, expect, it } from "vitest";
import { ApiError, UsageError, WrappedError, kindOf } from "../../src/core/errors";
import { AttachmentUploadError } from "../../src/services/attachments";
import { BatchSendError } from "../../src/services/batch";
import { UnguardableError } from "../../src/services/guard";
import { CommandFailureError, failuresOf, parseViolation, type AssetApiResponse } from "../../src/wire/assetApi";
import { parseOid } from "../../src/types/oid";

describe("error kinds", () => {
  it("every status and code maps to one kind a caller can branch on", () => {
    expect(kindOf(401)).toBe("auth");
    expect(kindOf(403)).toBe("forbidden");
    expect(kindOf(404)).toBe("notFound");
    expect(kindOf(400)).toBe("invalid");
    expect(kindOf(422)).toBe("invalid");
    for (const s of [408, 429, 500, 502, 503]) expect(kindOf(s)).toBe("transient");
    expect(kindOf(0, "TIMEOUT")).toBe("transient");
    expect(kindOf(0, "NETWORK_ERROR")).toBe("transient");
    expect(kindOf(0, "ABORTED")).toBe("aborted");
    expect(kindOf(200, "BAD_RESPONSE")).toBe("protocol");
    expect(kindOf(200, "CommandFailure")).toBe("commandFailure");
    expect(kindOf(400, "QUERY_REJECTED")).toBe("invalid");
    expect(kindOf(404, "NOT_FOUND")).toBe("notFound");
    expect(kindOf(413, "TOO_LARGE")).toBe("invalid");
    expect(kindOf(200)).toBe("unknown");
  });

  it("an ApiError carries its kind, and a cause when the details name one", () => {
    const inner = new Error("fetch failed");
    const e = new ApiError("x", 0, "NETWORK_ERROR", { cause: inner });
    expect(e.kind).toBe("transient");
    expect(e.cause).toBe(inner);
    expect(new ApiError("x", 401).kind).toBe("auth");
    expect(new ApiError("x", 500, undefined, undefined, "invalid").kind).toBe("invalid");
  });

  it("a mistake caught before any request is a UsageError: kind usage, status 0, still an ApiError", () => {
    const e = (() => { try { parseOid("S-1"); } catch (x) { return x as UsageError; } })()!;
    expect(e).toBeInstanceOf(UsageError);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("usage");
    expect(e.status).toBe(0);
    expect(new UnguardableError([{ index: 0, reason: "r" }])).toBeInstanceOf(UsageError);
  });

  it("an error wrapped around another keeps the cause's kind and status, so the service errors still branch", () => {
    const cause = new ApiError("Service Unavailable", 503);
    const w = new WrappedError("the send failed", "BATCH_SEND", cause);
    expect(w.kind).toBe("transient");
    expect(w.status).toBe(503);
    expect(w.cause).toBe(cause);
    expect(new WrappedError("x", "X", new Error("plain")).kind).toBe("unknown");
    const receipt = { receipt: 1 } as never;
    expect(new BatchSendError(cause, receipt).kind).toBe("transient");
    expect(new AttachmentUploadError({ oid: "Attachment:1", id: "1", name: null, filename: null, contentType: null, description: null, createDate: null, createdBy: null }, new ApiError("too big", 413, "TOO_LARGE")).kind).toBe("invalid");
  });

  it("a command failure is kind commandFailure, and its violations are parsed", () => {
    const response = { commandFailures: { count: 2, commands: [{ error: { message: "Violation'Required'AttributeDefinition'Scope'Story", sourceCommandIndex: 0 } }, { error: { message: "Input string was not in a correct format.", sourceCommandIndex: 1 } }] } } as unknown as AssetApiResponse;
    const e = new CommandFailureError(response);
    expect(e.kind).toBe("commandFailure");
    expect(failuresOf(response)[0]!.violation).toEqual({ rule: "Required", attribute: "Story.Scope", tag: "AttributeDefinition'Scope'Story" });
    expect(failuresOf(response)[1]!.violation).toBeNull();
  });

  it("parseViolation reads every spelling seen live, and nothing else", () => {
    expect(parseViolation("Violation'Required'AttributeDefinition'Scope'Story")).toEqual({ rule: "Required", attribute: "Story.Scope", tag: "AttributeDefinition'Scope'Story" });
    expect(parseViolation("Violation'Invalid'Epic.Scope")).toEqual({ rule: "Invalid", attribute: "Epic.Scope", tag: "Epic.Scope" });
    expect(parseViolation("Violation'AssetCannotDeleteClosed")).toEqual({ rule: "AssetCannotDeleteClosed", attribute: null, tag: null });
    expect(parseViolation("Unknown AttributeDefinition: Story.Nmae")).toBeNull();
    expect(parseViolation("")).toBeNull();
  });
});
