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

export type BooksIDsMap = { [filePath: string]: string };

function isFullDocumentContentPath(path: string): boolean {
  return path.split("/").includes("Full Document Contents");
}

function hasNumericSuffixBeforeExtension(path: string): boolean {
  return /\s\(\d+\)\.md$/i.test(path);
}

function compareCandidatePaths(left: string, right: string): number {
  const leftHasNumericSuffix = hasNumericSuffixBeforeExtension(left);
  const rightHasNumericSuffix = hasNumericSuffixBeforeExtension(right);

  if (leftHasNumericSuffix !== rightHasNumericSuffix) {
    return leftHasNumericSuffix ? 1 : -1;
  }

  if (left.length !== right.length) {
    return left.length - right.length;
  }

  return left.localeCompare(right);
}

/**
 * Resolve the vault path to update for an exported Readwise book.
 *
 * Readwise export artifacts can occasionally contain a new filename for a book
 * that already exists in the vault, such as `Book Title (467).md`. When the
 * settings map already knows a path for the same book ID, keep updating that
 * stable path instead of creating a duplicate suffixed file.
 */
export function stablePathForBookExport(
  booksIDsMap: BooksIDsMap,
  bookID: string,
  exportedPath: string,
): string {
  if (!bookID || booksIDsMap[exportedPath] === bookID) {
    return exportedPath;
  }

  const exportedIsFullDocumentContent = isFullDocumentContentPath(exportedPath);
  const candidates = Object.keys(booksIDsMap).filter((path) => {
    return booksIDsMap[path] === bookID
      && isFullDocumentContentPath(path) === exportedIsFullDocumentContent;
  });

  if (!candidates.length) {
    return exportedPath;
  }

  return candidates.sort(compareCandidatePaths)[0];
}
