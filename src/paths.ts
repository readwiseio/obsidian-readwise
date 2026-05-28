/** The name of the Readwise Sync history file, without the extension.
 * This is described as "Sync notification" in the Obsidian export settings
 * on the Readwise website. */
export const READWISE_SYNC_FILENAME = "Readwise Syncs" as const;

/**
 * The expected vault path of the "Readwise Syncs.md" file for a given base
 * folder. Unlike every other export entry it is plain markdown, not JSON, so
 * it must be detected by path and skipped from `JSON.parse`.
 *
 * The result is run through `normalizePath` because the caller compares it
 * against an already-normalized `processedFileName`. Without normalizing here,
 * a vault-root base folder (`"/"` or `""`) leaves a stray leading slash on this
 * side only, the comparison fails, and the markdown sync file is misparsed as
 * JSON ("No number after minus sign in JSON at position 1").
 */
export function readwiseSyncFilePath(
  readwiseDir: string,
  normalizePath: (path: string) => string,
): string {
  return normalizePath(`${readwiseDir}/${READWISE_SYNC_FILENAME}.md`);
}
