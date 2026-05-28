const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readwiseSyncFilePath } = require("../.test-build/src/paths");

// Faithful copy of Obsidian's normalizePath (the real one lives in the
// "obsidian" runtime, which is not available under `node --test`).
function normalizePath(path) {
  path = path.replace(/([\\/])+/g, "/");
  path = path.replace(/(^\/+|\/+$)/g, "");
  path = path.replace(/ | /g, " ");
  if (path === "") path = "/";
  return path;
}

// Mirrors how main.ts derives `processedFileName` for the backend's
// "Readwise/Readwise Syncs.md" export entry.
function processedSyncName(readwiseDir) {
  return normalizePath("Readwise/Readwise Syncs.md".replace(/^Readwise/, readwiseDir));
}

test("sync file path matches the processed entry for a vault-root base folder", () => {
  // Regression: before normalizing the expected path, "/" and "" left a stray
  // leading slash so the markdown sync file was misparsed as JSON.
  for (const dir of ["/", ""]) {
    assert.equal(
      readwiseSyncFilePath(dir, normalizePath),
      processedSyncName(dir),
      `readwiseDir=${JSON.stringify(dir)} should resolve to the sync file`,
    );
  }
});

test("sync file path matches the processed entry for default and nested base folders", () => {
  for (const dir of ["Readwise", "Notes/Readwise"]) {
    assert.equal(readwiseSyncFilePath(dir, normalizePath), processedSyncName(dir));
  }
});
