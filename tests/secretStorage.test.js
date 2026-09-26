const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  TOKEN_SECRET_ID,
  hasSecretStorage,
  isFreshInstall,
  isStranded,
  getToken,
  setToken,
  clearToken,
  migrateTokenToKeychain,
} = require("../.test-build/src/secretStorage");

function fakeSecretStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getSecret(id) {
      return Object.prototype.hasOwnProperty.call(store, id) ? store[id] : null;
    },
    setSecret(id, secret) {
      store[id] = secret;
    },
  };
}

test("hasSecretStorage reflects whether app.secretStorage is present", () => {
  assert.equal(hasSecretStorage({}), false);
  assert.equal(hasSecretStorage({ secretStorage: fakeSecretStorage() }), true);
});

test("isFreshInstall is true only when loadData returned null/undefined", () => {
  assert.equal(isFreshInstall(null), true);
  assert.equal(isFreshInstall(undefined), true);
  assert.equal(isFreshInstall({}), false);
  assert.equal(isFreshInstall({ token: "" }), false);
});

test("isStranded is true when keychainOnly but SecretStorage is unavailable", () => {
  assert.equal(isStranded({}, { token: "", keychainOnly: true }), true);
  assert.equal(isStranded({ secretStorage: fakeSecretStorage() }, { token: "", keychainOnly: true }), false);
  assert.equal(isStranded({}, { token: "", keychainOnly: false }), false);
});

test("getToken reads plaintext settings when not in keychain-only mode", () => {
  const settings = { token: "plain-token", keychainOnly: false };
  assert.equal(getToken({ secretStorage: fakeSecretStorage() }, settings), "plain-token");
});

test("getToken reads from SecretStorage when in keychain-only mode", () => {
  const app = { secretStorage: fakeSecretStorage({ [TOKEN_SECRET_ID]: "keychain-token" }) };
  const settings = { token: "", keychainOnly: true };
  assert.equal(getToken(app, settings), "keychain-token");
});

test("getToken returns empty string when stranded", () => {
  const settings = { token: "", keychainOnly: true };
  assert.equal(getToken({}, settings), "");
});

test("setToken writes to SecretStorage and blanks plaintext when keychain-only", () => {
  const app = { secretStorage: fakeSecretStorage() };
  const settings = { token: "old-plain", keychainOnly: true };
  setToken(app, settings, "new-token");
  assert.equal(settings.token, "");
  assert.equal(app.secretStorage.getSecret(TOKEN_SECRET_ID), "new-token");
});

test("setToken falls back to plaintext when not keychain-only", () => {
  const settings = { token: "", keychainOnly: false };
  setToken({ secretStorage: fakeSecretStorage() }, settings, "new-token");
  assert.equal(settings.token, "new-token");
});

test("setToken falls back to plaintext when keychain-only but SecretStorage unavailable", () => {
  const settings = { token: "", keychainOnly: true };
  setToken({}, settings, "new-token");
  assert.equal(settings.token, "new-token");
});

test("clearToken uses deleteSecret when available", () => {
  const store = { [TOKEN_SECRET_ID]: "to-delete" };
  let deleted = false;
  const app = {
    secretStorage: {
      getSecret: (id) => store[id] ?? null,
      setSecret: (id, secret) => { store[id] = secret; },
      deleteSecret: (id) => { deleted = true; delete store[id]; },
    },
  };
  const settings = { token: "", keychainOnly: true };
  clearToken(app, settings);
  assert.equal(deleted, true);
  assert.equal(store[TOKEN_SECRET_ID], undefined);
});

test("clearToken falls back to an empty-string tombstone when deleteSecret is unavailable", () => {
  const app = { secretStorage: fakeSecretStorage({ [TOKEN_SECRET_ID]: "to-delete" }) };
  const settings = { token: "", keychainOnly: true };
  clearToken(app, settings);
  assert.equal(app.secretStorage.getSecret(TOKEN_SECRET_ID), "");
});

test("clearToken always blanks the plaintext token", () => {
  const settings = { token: "leftover", keychainOnly: false };
  clearToken({}, settings);
  assert.equal(settings.token, "");
});

test("migrateTokenToKeychain moves plaintext token into SecretStorage and flips the mode", () => {
  const app = { secretStorage: fakeSecretStorage() };
  const settings = { token: "plain-token", keychainOnly: false };
  const migrated = migrateTokenToKeychain(app, settings);
  assert.equal(migrated, true);
  assert.equal(settings.keychainOnly, true);
  assert.equal(settings.token, "");
  assert.equal(app.secretStorage.getSecret(TOKEN_SECRET_ID), "plain-token");
});

test("migrateTokenToKeychain is a no-op when SecretStorage is unavailable", () => {
  const settings = { token: "plain-token", keychainOnly: false };
  const migrated = migrateTokenToKeychain({}, settings);
  assert.equal(migrated, false);
  assert.equal(settings.keychainOnly, false);
  assert.equal(settings.token, "plain-token");
});
