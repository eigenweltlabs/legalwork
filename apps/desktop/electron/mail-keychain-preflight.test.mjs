import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEmbeddedServerEnvironment } from "./runtime-environment.mjs";
import { assertMailKeychainReady } from "./mail-keychain-preflight.mjs";
import { createMailKeyStore } from "./mail-key-store.mjs";

test("embedded server keeps the OS home while child environment remains isolated", () => {
  const parent = { HOME: "/real/home", USERPROFILE: "C:\\Users\\owner" };
  const child = { HOME: "/isolated/home", USERPROFILE: "/isolated/home", XDG_CONFIG_HOME: "/isolated/config" };
  applyEmbeddedServerEnvironment(parent, child);
  assert.equal(parent.HOME, "/real/home");
  assert.equal(parent.USERPROFILE, "C:\\Users\\owner");
  assert.equal(parent.XDG_CONFIG_HOME, "/isolated/config");
  assert.equal(child.HOME, "/isolated/home");
});

test("missing or redirected macOS keychains fail before native vault access", async () => {
  let nativeCalls = 0;
  /** @type {Pick<import("electron").SafeStorage, "isEncryptionAvailable"|"encryptString"|"decryptString"|"getSelectedStorageBackend">} */
  const safeStorage = {
    isEncryptionAvailable() { nativeCalls++; return true; },
    encryptString() { nativeCalls++; return Buffer.alloc(0); },
    decryptString() { nativeCalls++; return ""; },
    getSelectedStorageBackend() { nativeCalls++; return "gnome_libsecret"; },
  };
  for (const options of [
    { home: "/wrong", query: async () => { throw Error("must not query"); } },
    { home: "/real", query: async () => { throw Error("no default"); } },
    { home: "/real", query: async () => '"/missing.keychain-db"', inspect: async () => { throw Error("missing"); } },
  ]) {
    const beforeAccess = () => assertMailKeychainReady({ platform: "darwin", osHome: () => "/real", ...options });
    const store = createMailKeyStore({ directory: "/unused-mail-preview", safeStorage, beforeAccess });
    await assert.rejects(store.load({ allowCreate: true }), /mail_key_backend_unavailable/);
  }
  assert.equal(nativeCalls, 0);
});
