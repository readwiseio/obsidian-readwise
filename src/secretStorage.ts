/**
 * Helpers for storing the Readwise API token in Obsidian's Keychain
 * (`App.secretStorage`, added in Obsidian 1.11.4) instead of plaintext in
 * `data.json`.
 * 
 * Reference: https://docs.obsidian.md/plugins/guides/secret-storage
 * API: https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage
 *
 * This module has no dependency on the `obsidian` package so it can be unit
 * tested without mocking Obsidian. Callers pass in whatever duck-types as
 * `SecretStorageHost` (typically the plugin's `App` instance).
 */

/**
 * Duck-typed view of Obsidian's `SecretStorage` class. `deleteSecret` isn't
 * in the published type declarations, but exists at runtime on Obsidian
 * builds that support it - treated as optional so callers can feature-detect
 * it and fall back to overwriting with an empty string.
 */
export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
  deleteSecret?(id: string): void;
}

export interface SecretStorageHost {
  secretStorage?: SecretStorageLike;
}

export interface TokenSettings {
  token: string;
  keychainOnly: boolean;
}

/** Lowercase alphanumeric with dashes, as required by SecretStorage IDs. */
export const TOKEN_SECRET_ID = "readwise-official-token";

export function hasSecretStorage(app: SecretStorageHost): boolean {
  return !!app.secretStorage;
}

/**
 * True if `rawData` indicates this device has never had a `data.json` for
 * this plugin before (i.e. `Plugin.loadData()` returned nothing). Used to
 * put brand-new installs straight into keychain-only mode, since there's no
 * existing plaintext token or synced-device expectations to worry about.
 *
 * Inspired by
 * https://github.com/logancyang/obsidian-copilot/blob/632c1e81b3a737f9931292ca7a667b143dc25614/src/services/settingsPersistence.ts#L313-L315
 */
export function isFreshInstall(rawData: unknown): boolean {
  return rawData === null || rawData === undefined;
}

/**
 * True when a vault was migrated to keychain-only mode but is being opened
 * on a device/Obsidian build without SecretStorage support. The token isn't
 * actually gone - it's just inaccessible here - so callers should say so
 * rather than presenting this as "not connected".
 *
 * Inspired by
 * https://github.com/logancyang/obsidian-copilot/blob/632c1e81b3a737f9931292ca7a667b143dc25614/src/services/settingsPersistence.ts#L332-L352
 */
export function isStranded(app: SecretStorageHost, settings: TokenSettings): boolean {
  return settings.keychainOnly && !hasSecretStorage(app);
}

export function getToken(app: SecretStorageHost, settings: TokenSettings): string {
  if (settings.keychainOnly) {
    if (!app.secretStorage) return "";
    return app.secretStorage.getSecret(TOKEN_SECRET_ID) ?? "";
  }
  return settings.token;
}

/**
 * Stores `value` as the Readwise token: to Obsidian Keychain when the vault
 * is in keychain-only mode, otherwise to the plaintext `token` setting.
 * Mutates `settings` in place; the caller is responsible for persisting it.
 */
export function setToken(app: SecretStorageHost, settings: TokenSettings, value: string): void {
  if (settings.keychainOnly && app.secretStorage) {
    app.secretStorage.setSecret(TOKEN_SECRET_ID, value);
    settings.token = "";
  } else {
    settings.token = value;
  }
}

/**
 * Clears the stored token from wherever it currently lives. Mutates
 * `settings` in place; the caller is responsible for persisting it.
 */
export function clearToken(app: SecretStorageHost, settings: TokenSettings): void {
  if (settings.keychainOnly && app.secretStorage) {
    const storage = app.secretStorage;
    // Reason: deleteSecret exists at runtime but is not in the official type
    // definitions. Prefer real deletion; fall back to empty-string tombstone.
    // Reference: https://github.com/logancyang/obsidian-copilot/blob/632c1e81b3a737f9931292ca7a667b143dc25614/src/services/keychainService.ts#L284-L292
    if (typeof storage.deleteSecret === "function") {
      storage.deleteSecret(TOKEN_SECRET_ID);
    } else {
      storage.setSecret(TOKEN_SECRET_ID, "");
    }
  }
  settings.token = "";
}

/**
 * Moves an existing plaintext token into Obsidian Keychain and switches the
 * vault into keychain-only mode. Returns false without changing anything if
 * SecretStorage isn't available on this device. Mutates `settings` in
 * place; the caller is responsible for persisting it.
 */
export function migrateTokenToKeychain(app: SecretStorageHost, settings: TokenSettings): boolean {
  if (!app.secretStorage) return false;
  if (settings.token) {
    app.secretStorage.setSecret(TOKEN_SECRET_ID, settings.token);
  }
  settings.token = "";
  settings.keychainOnly = true;
  return true;
}