import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createMailKeyStore } from "./mail-key-store.mjs";

/** Lazy desktop-only binding. No worker or OS-vault access until explicit unlock.
 * @param {{app: Pick<import("electron").App, "getPath"|"isReady">,
 * embeddedPath:string, safeStorage: Pick<import("electron").SafeStorage,
 * "isEncryptionAvailable"|"encryptString"|"decryptString"|"getSelectedStorageBackend">}} options
 */
export async function createDesktopMailService({ app, embeddedPath, safeStorage }) {
  const directory = join(app.getPath("userData"), "mail");
  const keyStore = createMailKeyStore({ directory, safeStorage });
  const dist = dirname(embeddedPath);
  const { LocalMailService } = await import(pathToFileURL(join(dist, "mail/service.js")).href);
  return new LocalMailService({
    executable: { kind: "electron", path: app.getPath("exe") },
    entryPoint: join(dist, "mail/runtime/worker.js"),
    databasePath: join(directory, "mail.sqlite"),
    // This database belongs to this local OS desktop profile. It has no remotely
    // selectable owner; future multi-user server support requires its own binding.
    ownerId: "desktop-local",
    loadKey: async () => {
      if (!app.isReady()) throw new Error("mail_key_backend_unavailable");
      return keyStore.load({ allowCreate: true });
    },
  });
}
