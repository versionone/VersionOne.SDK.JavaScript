/**
 * A browser app on the instance's own origin: no token, the browser's
 * session cookie authenticates, and the session can expire under the user.
 * `onUnauthorized` is where the app signs in again; its answer decides
 * whether the refused request is sent once more.
 *
 * So that it runs anywhere, this example replaces `fetch` with a small
 * stand-in for the server, whose session expires on demand. It needs no
 * instance and writes nothing; in a browser, delete the stand-in.
 *
 *   node examples/09-browser-session.ts
 */
import { AgilityApiClient, ApiError } from "@versionone/agility-sdk";

// ---- the stand-in server: a session that can expire, and a log of what ran ----
let session = true;
const ran: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input)).pathname.replace("/MyInstance", "");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!session) return json({ error: "session expired" }, 401);        // refused before anything ran
  ran.push(`${init.method ?? "GET"} ${path}`);
  if (path === "/loc-2.v1") return json({ "AssetType'Story": "Story" });
  if (path === "/api/asset") return json({ requestId: "example", createdDate: "", completedDate: "", duration: "", durationSeconds: 0, commandFailures: { commands: [], count: 0 }, assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: ["Story:1"], count: 1 }, assetsOperatedOn: { oidTokens: [], count: 0 }, queryResult: { results: [], count: 0 } });
  return json({}, 404);
}) as typeof fetch;

// ---- the app ----
let signIns = 0;
async function signInAgain(): Promise<boolean> {
  // In an app: a silent refresh, or a sign-in dialog the user completes.
  signIns += 1;
  session = true;
  return true;
}

const client = new AgilityApiClient({
  baseUrl: "https://agility.example.com/MyInstance",
  credentials: "include",                     // send the session cookie; no accessToken
  // No `X-Requested-With` header here, so an ended session answers 401 and
  // the hook below runs. An app that sends `X-Requested-With:
  // XMLHttpRequest` was seen to get a 403 for an ended session instead: it
  // adds `unauthorizedStatuses: [401, 403]`, and its hook first checks that
  // the session is really gone, since a 403 may also be a permission denial.
  onUnauthorized: async ({ retryable }) => {
    if (!(await signInAgain())) return "fail";
    // "retry" resends what is safe to send twice: a GET, a read. Never a
    // write, guarded or not. `retryable` says whether this request is one.
    if (retryable) return "retry";
    // A write is never resent by "retry": if it ran before the refusal,
    // sending it again would apply it twice. "retry-write" resends it
    // anyway, and is YOUR assertion that on your server a refusal for an
    // expired session means nothing in the request was executed. It has
    // been seen to hold on one release for a missing, an invalid and an
    // expired credential (a 401 before any command ran, on api/asset and
    // on a rest-1 write); not for a 403. Answer it only if you know it
    // holds for you; otherwise answer "fail" and let the user retry.
    return "retry-write";
  }
});

// A read while the session is good.
console.log(await client.localize(["AssetType'Story"]));

// The session expires. The next read is refused, the hook signs in again,
// and the read is sent once more: the caller never sees the refusal.
session = false;
console.log(await client.localize(["AssetType'Story"]), `after ${signIns} sign-in`);

// It expires again, under a write. With "retry-write" the write is resent.
session = false;
const outcome = await client.send([{ from: "Story:1", update: { Estimate: 3 } }]);
console.log(`modified ${outcome.modified.join(", ")} after ${signIns} sign-ins; the server ran: ${ran.join(" | ")}`);

// A hook that cannot sign in answers "fail", and the caller gets the
// refusal: an ApiError of kind "auth".
session = false;
const strict = new AgilityApiClient({ baseUrl: "https://agility.example.com/MyInstance", credentials: "include", onUnauthorized: () => "fail" });
try {
  await strict.localize(["AssetType'Story"]);
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  console.log(`not signed in: kind ${error.kind}, status ${error.status}`);
}
