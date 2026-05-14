const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { StatusBar } = require("../.test-build/src/status");

const originalDateNow = Date.now;

function createStatusBar() {
  const calls = [];
  const statusBar = new StatusBar({
    setText(text) {
      calls.push(text);
    },
  });

  return { calls, statusBar };
}

afterEach(() => {
  Date.now = originalDateNow;
});

test("StatusBar displays messages with the Readwise prefix", () => {
  const { calls, statusBar } = createStatusBar();

  statusBar.displayMessage("Sync completed", 4);

  assert.deepEqual(calls, ["readwise: Sync completed"]);
});

test("StatusBar keeps later messages queued until the current timeout expires", () => {
  Date.now = () => 0;
  const { calls, statusBar } = createStatusBar();

  statusBar.displayMessage("Syncing highlights", 1);
  statusBar.displayMessage("Sync completed", 1);

  assert.deepEqual(calls, ["readwise: Syncing highlights"]);

  Date.now = () => 1000;
  statusBar.display();
  statusBar.display();

  assert.deepEqual(calls, [
    "readwise: Syncing highlights",
    "readwise: Sync completed",
  ]);
});

test("StatusBar clears the current message before displaying a forced message", () => {
  const { calls, statusBar } = createStatusBar();

  statusBar.displayMessage("Waiting for export", 5);
  statusBar.displayMessage("Sync failed", 5, true);

  assert.deepEqual(calls, [
    "readwise: Waiting for export",
    "",
    "readwise: Sync failed",
  ]);
});

test("StatusBar truncates long messages before displaying them", () => {
  const { calls, statusBar } = createStatusBar();
  const longMessage = "a".repeat(120);

  statusBar.displayMessage(longMessage, 4);

  assert.deepEqual(calls, [`readwise: ${"a".repeat(100)}`]);
});
