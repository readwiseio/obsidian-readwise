const assert = require("node:assert/strict");
const Module = require("node:module");
const { afterEach, beforeEach, test } = require("node:test");

const notices = [];
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "obsidian") {
    return {
      Modal: class {},
      Notice: class { constructor(msg) { notices.push(msg); } },
      Plugin: class {},
      PluginSettingTab: class {},
      normalizePath: (path) => path,
    };
  }
  return originalLoad.call(this, request, ...args);
};
const ReadwisePlugin = require("../.test-build/src/main").default;
Module._load = originalLoad;

function createPlugin(isMobile) {
  const statusMessages = [];
  const plugin = Object.create(ReadwisePlugin.prototype);
  plugin.app = { isMobile };
  plugin.statusBar = { displayMessage: (msg) => statusMessages.push(msg) };
  return { plugin, statusMessages };
}

beforeEach(() => { notices.length = 0; });
afterEach(() => { notices.length = 0; });

test("notice on mobile does not turn status bar progress into a toast", () => {
  const { plugin, statusMessages } = createPlugin(true);

  plugin.notice("Exporting Readwise data (1 / 10) ...", false, 35, true);
  plugin.notice("Building export...");
  plugin.notice("Readwise data is already up to date", false, 4);

  assert.deepEqual(notices, []);
  assert.deepEqual(statusMessages, []);
});

test("notice on mobile still shows explicit toasts once", () => {
  const { plugin } = createPlugin(true);

  plugin.notice("Readwise sync completed", true, 1, true);
  plugin.notice("Sync failed", true, 4, true);

  assert.deepEqual(notices, ["Readwise sync completed", "Sync failed"]);
});

test("notice on desktop routes status messages to the status bar", () => {
  const { plugin, statusMessages } = createPlugin(false);

  plugin.notice("Building export...");
  plugin.notice("Readwise sync completed", true, 1, true);

  assert.deepEqual(statusMessages, ["building export...", "readwise sync completed"]);
  assert.deepEqual(notices, ["Readwise sync completed"]);
});
