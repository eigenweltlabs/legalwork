import { expect, test } from "bun:test";
import { storageInputSchema, type StorageOAuthStatus } from "@legalwork/types/file-storage";
import { saveStorageAndSignIn } from "../src/react-app/domains/settings/pages/storage-connect";

const input = storageInputSchema.parse({ name: "Client documents", config: { kind: "oauth", provider: "dropbox", root: "" }, enabled: true });
function fixture(statuses: StorageOAuthStatus[]) {
  const events: string[] = [];
  const connection = { ...input, id: "new-dropbox", updatedAt: 1, configuredSecrets: [] };
  const controller = new AbortController();
  const client = {
    saveStorageConnection: async () => { events.push("save"); return { connection }; },
    removeStorageConnection: async () => { events.push("remove"); return { ok: true }; },
    storageOAuthStatus: async () => { events.push("status"); return statuses.shift() ?? { connected: false, pending: false }; },
    storageOAuthStart: async () => { events.push("start"); return { authUrl: "https://example.invalid/sign-in" }; },
    storageOAuthDisconnect: async () => { events.push("disconnect"); return { ok: true }; },
  };
  const options = { signal: controller.signal, onWaiting: () => { events.push("waiting"); }, openLink: (url: string) => { events.push(`open:${url}`); } };
  return { events, client, options, controller };
}

test("new Dropbox setup opens sign-in and completes only after authentication", async () => {
  const f = fixture([{ connected: false, pending: false }, { connected: true, pending: false }]);
  const result = await saveStorageAndSignIn(f.client, "workspace", input, f.options);
  expect(result.id).toBe("new-dropbox");
  expect(f.events).toEqual(["save", "status", "start", "waiting", "open:https://example.invalid/sign-in", "status"]);
});

test("denied sign-in removes the unfinished Dropbox connection", async () => {
  const f = fixture([{ connected: false, pending: false }, { connected: false, pending: false, error: "Sign-in denied" }]);
  await expect(saveStorageAndSignIn(f.client, "workspace", input, f.options)).rejects.toThrow("Sign-in denied");
  expect(f.events.at(-1)).toBe("remove");
});

test("closing setup while waiting cancels and removes only its newly created connection", async () => {
  const f = fixture([{ connected: false, pending: false }, { connected: false, pending: true }]);
  const saving = saveStorageAndSignIn(f.client, "workspace", input, { ...f.options, openLink: () => { f.controller.abort(); } });
  await expect(saving).rejects.toThrow();
  expect(f.events.at(-1)).toBe("remove");
  expect(f.events).not.toContain("disconnect");
});

test("cancellation racing the initial save still cleans up the temporary record", async () => {
  const f = fixture([]);
  f.controller.abort();
  await expect(saveStorageAndSignIn(f.client, "workspace", input, f.options)).rejects.toThrow();
  expect(f.events).toEqual(["save", "remove"]);
});

test("failed reauthentication preserves the existing connection and cancels its flow", async () => {
  const f = fixture([{ connected: false, pending: false }, { connected: false, pending: false }]);
  await expect(saveStorageAndSignIn(f.client, "workspace", input, { ...f.options, id: "existing" })).rejects.toThrow();
  expect(f.events.at(-1)).toBe("disconnect");
  expect(f.events).not.toContain("remove");
});

test("a saved valid grant is reused and folder views never start another sign-in", async () => {
  const f = fixture([{ connected: true, pending: false }]);
  await saveStorageAndSignIn(f.client, "workspace", input, { ...f.options, id: "existing" });
  expect(f.events).toEqual(["save", "status"]);
  const folder = fixture([]);
  await saveStorageAndSignIn(folder.client, "workspace", { ...input, config: { kind: "oauth", provider: "google-drive", root: "folder", accountId: "account" } }, folder.options);
  expect(folder.events).toEqual(["save"]);
});

test("an unavailable status check does not disconnect an existing account", async () => {
  const f = fixture([]);
  f.client.storageOAuthStatus = async () => { throw new Error("Offline"); };
  await expect(saveStorageAndSignIn(f.client, "workspace", input, { ...f.options, id: "existing" })).rejects.toThrow("Offline");
  expect(f.events).toEqual(["save"]);
});
