/**
 * One-off migration helper — runs ON VAL TOWN, not in this Worker.
 *
 * Temporarily added to the cathadan/smx-unplayed-songs val as an HTTP file so
 * its val-scoped blobs (only readable from inside the val) can be copied into
 * this Worker's KV namespace. It responds with every `smx-unplayed:*` blob in
 * `wrangler kv bulk put` format, values base64-encoded so the gzip bytes
 * survive unchanged:
 *
 *   curl -s "<endpoint>/?token=<EXPORT_TOKEN>" > blobs.json
 *   npx wrangler kv bulk put blobs.json --binding CACHE --remote
 *
 * The val's code is public, so the token only keeps casual hits off it for
 * the few minutes this is deployed; the data itself is derived from the public
 * 573.no API. Delete the file from the val right after the copy.
 */

import { blob } from "https://esm.town/v/std/blob/main.ts";

const EXPORT_TOKEN = "REPLACE_ME"; // used once on 2026-11-11, then removed from the val
const PREFIX = "smx-unplayed:";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export default async function handler(req: Request): Promise<Response> {
  if (new URL(req.url).searchParams.get("token") !== EXPORT_TOKEN) {
    return new Response("Not found", { status: 404 });
  }
  const keys = (await blob.list(PREFIX)).map((b) => b.key);
  const entries = await Promise.all(keys.map(async (key) => {
    const res = await blob.get(key);
    const value = toBase64(new Uint8Array(await res.arrayBuffer()));
    return { key, value, base64: true };
  }));
  return Response.json(entries);
}
