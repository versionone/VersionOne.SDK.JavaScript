/**
 * OID tokens, the one spelling every endpoint shares: "Story:1234", or with
 * a moment, "Story:1234:5678". The model carries the momentless form except
 * where the moment is the identity (a history row). Every consumer had its
 * own copy of these (agility-rooms' AssetOidHelper, ossum-ui's toMomentless,
 * gh-v1's momentless, v1sdk 2.x's Oid class); this is the one they share.
 */
import type { Oid } from "./asset";

export interface OidParts {
  type: string;
  id: number;
  /** The moment, when the token carries one. */
  moment: number | null;
}

const OID_TOKEN = /^([A-Za-z][A-Za-z0-9_]*):(\d+)(?::(\d+))?$/;

/** Is this an OID token? "Story:1234" and "Story:1234:5678" are; "S-1234" and "Story" are not. */
export function isOidToken(value: unknown): value is Oid {
  return typeof value === "string" && OID_TOKEN.test(value);
}

/** The parts of an OID token. Throws on anything that is not one. */
export function parseOid(token: string): OidParts {
  const m = OID_TOKEN.exec(token);
  if (!m) throw new Error(`"${token}" is not an OID token (Story:1234)`);
  return { type: m[1]!, id: Number(m[2]), moment: m[3] === undefined ? null : Number(m[3]) };
}

/** An OID token without its moment: "Story:1234:5678" -> "Story:1234". Anything that is not a token is returned as is. */
export function momentless(token: string): Oid {
  const m = OID_TOKEN.exec(token);
  return m ? `${m[1]}:${m[2]}` : token;
}

/** The asset type of an OID token: "Story:1234" -> "Story". */
export function typeOfOid(token: string): string {
  return parseOid(token).type;
}

/** An OID token from its parts. */
export function toOid(type: string, id: number, moment?: number | null): Oid {
  return moment == null ? `${type}:${id}` : `${type}:${id}:${moment}`;
}
