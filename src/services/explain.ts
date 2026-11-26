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
  /** One short sentence. English, with the instance's own labels for attributes and asset types. */
  sentence: string;
  /**
   * Is `sentence` fit to show a person using the consumer's product? True
   * when it was made for one: from a rule and the instance's labels, from
   * the server's own localized sentence, or from the kind of error
   * ("Agility could not be reached…"). False when it is only the message
   * as it came — a token the instance has no words for
   * (`Violation'AssetCannotInactivateClosed`), the server's raw text, or a
   * message written for a developer (a usage error, a protocol error):
   * log those, and show the user something of your own.
   */
  explained: boolean;
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

function sentenceOf(problem: Problem, label: string | null, related: string | null, localized: string | null, message: string): { sentence: string; explained: boolean } {
  if (label) {
    switch (problem.rule) {
      case "Required": return { sentence: `${label} is required.`, explained: true };
      case "Invalid": return { sentence: `${label} is not valid.`, explained: true };
      case "Unresolved": return { sentence: `${label}: no ${related ?? "asset"} matches the value given.`, explained: true };
      case "Ambiguous": return { sentence: `${label}: more than one ${related ?? "asset"} matches the value given.`, explained: true };
    }
  }
  // The server's own sentence where it has one; otherwise the message as it came, which explains nothing to a user.
  return localized ? { sentence: localized, explained: true } : { sentence: message, explained: false };
}

/** The failures to explain, from whatever the caller holds: an Outcome, a list of failures, or a thrown error. */
function failuresOf(input: unknown): CommandFailureDetail[] | null {
  if (Array.isArray(input)) return input as CommandFailureDetail[];
  if (input && typeof input === "object" && Array.isArray((input as { failures?: unknown }).failures)) return (input as Pick<Outcome, "failures">).failures;
  return null;
}

/** A sentence for an error that is not a list of failed commands, by its kind, and whether it is one for a user. */
function sentenceForError(error: unknown): { sentence: string; explained: boolean } {
  if (!(error instanceof ApiError)) return { sentence: error instanceof Error ? error.message : String(error), explained: false };
  switch (error.kind) {
    case "auth": return { sentence: "Agility did not accept the sign-in: the token is missing, wrong or no longer valid.", explained: true };
    case "forbidden": return { sentence: "Agility refused: this member is not allowed to do that.", explained: true };
    case "transient": return { sentence: "Agility could not be reached, or is busy. The same request may work in a moment.", explained: true };
    case "aborted": return { sentence: "The request was cancelled.", explained: true };
    case "conflict": return { sentence: "Someone else changed this since it was read; nothing was applied. Look at it again and decide.", explained: true };
    // notFound, invalid, usage, protocol and the rest: the message is the SDK's or the server's own, written for whoever made the call.
    default: return { sentence: error.message, explained: false };
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
  if (!failures) return [{ ...sentenceForError(input), index: null, rule: null, attribute: null, attributeLabel: null, typeLabel: null, localized: null, message: input instanceof Error ? input.message : String(input) }];
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
    return { ...sentenceOf(p, attributeLabel, related, localized, f.message), index: f.index, rule: p.rule, attribute: p.attribute, attributeLabel, typeLabel, localized, message: f.message };
  });
}
