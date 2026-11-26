/**
 * Attachments: add a file to an asset, list, read it back, remove it.
 *
 * This example WRITES: one Story named "sdk-integration example …" with one
 * attachment, both deleted before it ends. See 02-write.ts for
 * V1_EXAMPLES_WRITE.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… V1_EXAMPLES_WRITE=1 node examples/06-attachments.ts
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN, V1_EXAMPLES_WRITE } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
if (V1_EXAMPLES_WRITE !== "1") throw new Error("this example creates and deletes a Story and an attachment; set V1_EXAMPLES_WRITE=1 on an instance where that is acceptable");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const name = `sdk-integration example attachment ${new Date().toISOString()}`;

const story = (await client.send([{ AssetType: "Story", Name: name, Scope: { _oid: "Scope:0" } }], { throwOnFailure: true })).created[0]!;
let attachment: string | undefined;
try {
  // Bytes are a Uint8Array, an ArrayBuffer or a Blob. `add` answers the
  // attachment as written; `id` is the number its bytes are addressed by.
  const added = await client.attachments.add(story, new TextEncoder().encode("hello from an example\n"), { filename: "sdk-integration example.txt", contentType: "text/plain", description: "written by an example" });
  attachment = added._oid;
  console.log(`added ${added._oid} (${added.Filename}, ${added.ContentType})`);

  // A list answers metadata only: no bytes travel until you ask for a file.
  for (const a of await client.attachments.list(story)) console.log(`listed ${a._oid}: ${a.Filename}, created ${a.CreateDate} by ${a["CreatedBy.Name"]}`);

  // `inline: true` reads a small file's metadata and bytes in one request.
  const file = await client.attachments.get(added.id, { inline: true });
  console.log(`read ${file.bytes.byteLength} bytes: ${JSON.stringify(new TextDecoder().decode(file.bytes))}`);
  console.log(`a browser opens it at ${client.urls.attachment(added.id)}`);
} finally {
  if (attachment) await client.attachments.remove(attachment.split(":")[1]!);
  await client.send([{ from: story, execute: "Delete" }], { throwOnFailure: true });
  console.log(`deleted ${story} and its attachment`);
}
