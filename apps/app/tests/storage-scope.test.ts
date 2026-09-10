import { expect, test } from "bun:test";
import { storageInputSchema, type StorageConnection } from "@legalwork/types/file-storage";
import { storageConnectionsForScope } from "../src/react-app/domains/settings/pages/storage-scope";

test("Local lists installed connections while Team remains the shared catalog", () => {
  const local: StorageConnection = {
    ...storageInputSchema.parse({
      name: "Personal",
      config: { kind: "webdav", endpoint: "https://files.example.com" },
    }),
    id: "local",
    updatedAt: 1,
    configuredSecrets: [],
  };
  const automatic: StorageConnection = {
    ...local,
    id: "automatic",
    team: { orgId: "firm", version: 1, installed: true },
  };
  const optional: StorageConnection = {
    ...automatic,
    id: "optional",
    teamInstallation: "optional",
    team: { ...automatic.team!, installed: false },
  };
  const catalog = [local, automatic, optional];
  expect(storageConnectionsForScope(catalog, "local").map((item) => item.id)).toEqual(["local", "automatic"]);
  expect(storageConnectionsForScope(catalog, "team").map((item) => item.id)).toEqual(["automatic", "optional"]);
  const installed = { ...optional, team: { ...optional.team!, installed: true } };
  expect(storageConnectionsForScope([installed], "local")).toEqual([installed]);
  expect(storageConnectionsForScope([installed], "team")).toEqual([installed]);
});
