// The blob order of the key count point: what the key Worker writes into
// the `claudinite_key_counts` Analytics Engine dataset as blob1..blob5, and what
// `tools/key-counts.mjs` maps those columns back to. The index is the repo id and the one double is 1.

export const KEY_COUNT_BLOBS = ["plan", "outcome", "ownerType", "engineVersion", "path"] as const;
export type KeyCountBlob = (typeof KEY_COUNT_BLOBS)[number];

/** The point's blobs, one field each, in KEY_COUNT_BLOBS order. */
export function keyCountBlobs(p: Record<KeyCountBlob, string>): string[] {
  return KEY_COUNT_BLOBS.map((name) => p[name]);
}
