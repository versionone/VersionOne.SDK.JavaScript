/**
 * The explain service: an error, said to a person. Every consumer wrote
 * this once — a chat bot answered "Agility didn't accept that" while
 * holding the violation that said why, a CLI re-parsed failure messages
 * with its own patterns and asked loc-2 for three tags per failure.
 *
 * A failed command's message is a token (`Violation'Required'
 * AttributeDefinition'Scope'Story`, `Resolution'Unresolved'Story.Status'
 * StoryStatus`), not a sentence. This reads the token, asks loc-2 once for
 * every label it needs — the attribute's and the asset type's, in the
 * instance's own words ("Project", "Backlog Item"), and the server's own
 * sentence for the whole token where it has one — and answers a short
 * sentence plus the parts, so a caller can use either.
 *
 * Seen live (the API-testing instance, 2026-11-26):
 *   - loc-2 localizes a whole violation token, usefully for Required ("…The
 *     attribute Project is required and was not supplied…") and emptily for
 *     Invalid ("…has encountered an invalid ."), which is why the short
 *     sentence is built here from the labels and loc-2's is offered beside it.
 *   - an attribute is named as a loc-2 tag (AttributeDefinition'Scope'Story)
 *     or as a token (Story.Owners); a Resolution failure names the attribute
 *     as a token and then the related type.
 *   - loc-2 answers a tag it does not know with the tag itself.
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { CommandFailureDetail, Outcome } from "../types/command";
import type { AttributeTokenRef } from "../types/metamodel";
import { parseViolation } from "../types/command";
import * as loc2 from "../wire/loc2";

export interface Explanation {
  /**
   * One short sentence. English, with the instance's own labels for
   * attributes and asset types. For a failed command it states the reason
   * and nothing else ("Project is required.", "Refused (asset cannot
   * inactivate closed)."), so a caller can put its own words around it
   * ("Agility didn't accept that: …") without saying anything twice.
   */
  sentence: string;
  /**
   * Who the sentence is for. "user", in exactly three cases: a rule the
   * SDK knows, on an attribute, said with the instance's label for it
   * ("Project is required."); the server's own localized sentence; or a
   * sentence for the kind of error (not signed in, not found). It can be
   * shown as it is. "developer" for everything else: a message about the
   * call itself (a usage error, a rejected query, a protocol error), the
   * server's raw text, and a rule the instance has no sentence for, whose
   * name is spelled out in words ("Refused (message must not be sent).").
   * A spelled-out rule is never for a user: it is a name, and can read as
   * the opposite of what happened. Log these, and show the user
   * something of your own.
   */
  audience: "user" | "developer";
  /** True when `sentence` is nothing more than the message as the server (or the SDK) sent it: nothing was explained. */
  echoed: boolean;
  /**
   * Is it safe to send the same request again? True: nothing was changed
   * by the failed attempt (a read, anything the server turned away with
   * a 429).
   * False: a write that got no answer, or a server failure in answer to
   * one; the change may or may not have been made, so look before trying
   * again; or a read the server itself gave up on (SERVER_TIMEOUT), which
   * would cost and fail the same, so the request is to be made smaller,
   * not repeated. Null when the question does not arise (the server answered and
   * said why) or cannot be told (the error does not say what was asked,
   * as one from a `/wire` function on a bare transport does not). Decide
   * on this field, not on the wording of `sentence`. It answers one
   * question, "may the same request be sent again as it is?", and not
   * "did it happen?", which is `outcome`.
   */
  retrySafe: boolean | null;
  /**
   * Is it known whether the change was made? The second question after
   * a failed write, beside `retrySafe`, so nobody derives it from a
   * status and a method.
   *   - "unknown": a write (a request not safe to repeat) that got no
   *     confirmation: no answer, a timeout of the client's or the
   *     server's, a cancelled wait, a 5xx, an answer that could not be
   *     read. It may or may not have been applied: look before acting.
   *   - "notApplied": the server answered and refused before doing the
   *     work: a 4xx (a 429 included) in answer to a write, a guarded
   *     write that met a conflict, or, in the explanation of one failed
   *     command, that command. For a batch this speaks of that command
   *     alone: what became of the others is in the Outcome (`created`,
   *     `modified`, `failures`), not here.
   *   - null: a read, where there is nothing to apply, and an error
   *     that does not say what was asked.
   * A guarded write is a write here: with no confirmation it is
   * "unknown". Sending it again would not show which: a second send of
   * one that landed matches nothing and reads as a conflict.
   */
  outcome: "unknown" | "notApplied" | null;
  /** The failed command's index in the batch, when this explains one; null otherwise. */
  index: number | null;
  /** What was violated: Required, Invalid, Unresolved, Ambiguous, AssetCannotDeleteClosed, …; null when the message is not such a token. */
  rule: string | null;
  /** The attribute at fault ("Story.Scope"), when the message names one. */
  attribute: AttributeTokenRef | null;
  /** That attribute as the instance labels it ("Project"); its bare name when the instance has no label. */
  attributeLabel: string | null;
  /** The asset type as the instance labels it ("Backlog Item"); its token when the instance has no label. */
  typeLabel: string | null;
  /** The related asset type a Resolution failure names ("Member": the value given matched none, or several, of these); null otherwise. */
  relatedType: string | null;
  /** That type as the instance labels it; its token when the instance has no label. */
  relatedTypeLabel: string | null;
  /** The server's own sentence for the whole message, when loc-2 has one; null when it only echoes the token. */
  localized: string | null;
  /** The message as the server sent it. */
  message: string;
}

interface Problem { rule: string | null; attribute: AttributeTokenRef | null; related: string | null }

/** What a failure message says went wrong: a Violation (parseViolation), a Resolution, or nothing readable. */
function problemOf(message: string): Problem {
  const violation = parseViolation(message);
  if (violation) return { rule: violation.rule, attribute: violation.attribute, related: null };
  const parts = message.trim().split("'");
  if (parts[0] === "Resolution" && parts[1] && /^[A-Za-z]\w*\.[A-Za-z]\w*$/.test(parts[2] ?? "")) return { rule: parts[1], attribute: parts[2] as AttributeTokenRef, related: parts[3] || null };
  return { rule: null, attribute: null, related: null };
}

const attributeTag = (attribute: AttributeTokenRef): string => { const [type, name] = attribute.split("."); return `AttributeDefinition'${name}'${type}`; };
const typeTag = (type: string): string => `AssetType'${type}`;
/** A token that looks like one loc-2 would know: no spaces, apostrophe-delimited. A plain sentence is not asked about. */
const isTag = (message: string): boolean => /^[A-Za-z]\w*'[^\s]+$/.test(message.trim());

type Said = Pick<Explanation, "sentence" | "audience" | "echoed" | "retrySafe">;

/** What is known of the change an error's request asked for. See `Explanation.outcome`. */
function outcomeOf(error: unknown): Explanation["outcome"] {
  if (!(error instanceof ApiError)) return null;
  // The guard compared and found a difference: it sent nothing, or the server applied nothing.
  if (error.kind === "conflict") return "notApplied";
  if (!error.request || error.request.idempotent) return null;
  // A write. The server answered a refusal (4xx; a 408 is a timeout, not a refusal), or nobody knows.
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== "SERVER_TIMEOUT" ? "notApplied" : "unknown";
}
const forUser = (sentence: string, retrySafe: boolean | null = null): Said => ({ sentence, audience: "user", echoed: false, retrySafe });
const forDeveloper = (sentence: string, echoed: boolean): Said => ({ sentence, audience: "developer", echoed, retrySafe: null });

function sentenceOf(problem: Problem, label: string | null, related: string | null, localized: string | null, message: string): Said {
  if (label) {
    switch (problem.rule) {
      case "Required": return forUser(`${label} is required.`);
      case "Invalid": return forUser(`${label} is not valid.`);
      case "Unresolved": return forUser(`${label}: no ${related ?? "asset"} matches the value given.`);
      case "Ambiguous": return forUser(`${label}: more than one ${related ?? "asset"} matches the value given.`);
    }
  }
  // The server's own sentence where it has one.
  if (localized) return forUser(localized);
  // A rule the instance has no words for (seen live: Violation'AssetCannotInactivateClosed, Violation'MessageMustNotBeSent):
  // never the bare token, but the rule's name spelled out is still a token and not a sentence written for a person. It can
  // read as the opposite of what happened ("message must not be sent" is said of a message that was). So it is for a developer.
  if (problem.rule) return forDeveloper(`${label ? `${label}: refused` : "Refused"} (${words(problem.rule)}).`, false);
  // Anything else is the server's own text, as it came.
  return forDeveloper(message, true);
}
/** A rule's name as words: AssetCannotInactivateClosed → "asset cannot inactivate closed". */
const words = (rule: string): string => rule.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** The failures to explain, from whatever the caller holds: an Outcome, a list of failures, or a thrown error. */
function failuresOf(input: unknown): CommandFailureDetail[] | null {
  if (Array.isArray(input)) return input as CommandFailureDetail[];
  if (input && typeof input === "object" && Array.isArray((input as { failures?: unknown }).failures)) return (input as Pick<Outcome, "failures">).failures;
  return null;
}

/**
 * A request that got no answer, or a failure for one. What to tell a
 * person depends on what was asked, which the client stamps on the error
 * (`error.request`):
 *   - a 429, whatever was asked: the server turned it away before doing
 *     anything, so it is safe to send again;
 *   - a write (not idempotent) with no answer, a timeout or a 5xx: nobody
 *     knows whether the change was made, and saying "try again" is how a
 *     duplicate happens;
 *   - a read that timed out: safe to repeat, but it may still be
 *     running, so not at once;
 *   - a read that never got through: safe, and may work in a moment;
 *   - a read the server itself gave up on (its SQL execution timeout,
 *     code SERVER_TIMEOUT): harmless to the data and still not to be
 *     repeated (retrySafe false), since it will cost the server the same
 *     and fail the same; the thing to do is ask for less;
 *   - no stamp: say only what is known.
 */
function unanswered(error: ApiError): Said {
  if (error.status === 429) return forUser("Agility is busy. The same request may work in a moment.", true);
  const asked = error.request;
  if (error.code === "SERVER_TIMEOUT" && !asked) return forUser("Agility gave up on this request: it takes more work than the server allows.");
  if (!asked) return forUser("Agility could not be reached, or is busy.");
  if (!asked.idempotent) return forUser("Agility did not confirm the change. It may or may not have been made: check before trying again.", false);
  // The server itself gave up: the request costs more than it allows, and will cost the same again.
  if (error.code === "SERVER_TIMEOUT") return forUser("Agility gave up on this request: it takes more work than the server allows. Sending it again will cost the same. Ask for less: a smaller page, fewer selected paths, a tighter filter.", false);
  const timedOut = error.code === "TIMEOUT" || error.status === 408 || error.status === 504;
  if (timedOut) return forUser("Agility did not answer in time. The request may still be running: wait before trying again.", true);
  return forUser("Agility could not be reached, or is busy. The same request may work in a moment.", true);
}

/** A sentence for an error that is not a list of failed commands, by its kind, and who it is for. */
function sentenceForError(error: unknown): Said {
  if (!(error instanceof ApiError)) return forDeveloper(error instanceof Error ? error.message : String(error), true);
  switch (error.kind) {
    case "auth": return forUser("Agility did not accept the sign-in: the token is missing, wrong or no longer valid.");
    case "forbidden": return forUser("Agility refused: this member is not allowed to do that.");
    case "transient": return unanswered(error);
    case "aborted": return forUser("The request was cancelled.");
    case "conflict": return forUser("Someone else changed this since it was read; nothing was applied. Look at it again and decide.");
    // notFound, invalid, usage, protocol and the rest: the message is the SDK's or the server's own, about the call.
    default: return forDeveloper(error.message, true);
  }
}

/**
 * Explain an error, an Outcome's failures, or a list of failures: one
 * Explanation per failed command, or one for an error that is not about
 * commands. One loc-2 request at most, none when there is nothing to
 * label. Never throws for a label it could not get: the explanation then
 * uses the attribute's and type's own names.
 */
export async function explain(transport: Transport, input: unknown, options: loc2.LocalizeOptions = {}): Promise<Explanation[]> {
  const failures = failuresOf(input);
  if (!failures) return [{ ...sentenceForError(input), outcome: outcomeOf(input), index: null, rule: null, attribute: null, attributeLabel: null, typeLabel: null, relatedType: null, relatedTypeLabel: null, localized: null, message: input instanceof Error ? input.message : String(input) }];
  const problems = failures.map((f) => problemOf(f.message));
  const tags = new Set<string>();
  failures.forEach((f, i) => {
    const p = problems[i]!;
    if (isTag(f.message)) tags.add(f.message.trim());
    if (p.attribute) { tags.add(attributeTag(p.attribute)); tags.add(typeTag(p.attribute.split(".")[0]!)); }
    if (p.related) tags.add(typeTag(p.related));
  });
  let labels: loc2.Localizations = {};
  try {
    if (tags.size) labels = await loc2.localize(transport, [...tags], options);
  } catch { /* labels are a nicety: the names below stand in */ }
  // loc-2 answers a tag it does not know with the tag itself: that is "no label".
  const label = (tag: string): string | null => { const l = labels[tag]; return typeof l === "string" && l && l !== tag ? l : null; };
  return failures.map((f, i) => {
    const p = problems[i]!;
    const [type, name] = p.attribute ? p.attribute.split(".") : [null, null];
    const attributeLabel = p.attribute ? label(attributeTag(p.attribute)) ?? name! : null;
    const typeLabel = type ? label(typeTag(type)) ?? type : null;
    const related = p.related ? label(typeTag(p.related)) ?? p.related : null;
    const localized = isTag(f.message) ? label(f.message.trim()) : null;
    // The server reported this command as failed: it was not applied. Nothing is said here of the batch's other commands.
    return { ...sentenceOf(p, attributeLabel, related, localized, f.message), outcome: "notApplied", index: f.index, rule: p.rule, attribute: p.attribute, attributeLabel, typeLabel, relatedType: p.related, relatedTypeLabel: related, localized, message: f.message };
  });
}
