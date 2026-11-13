import type { StorageInput } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

type StorageClient = Pick<LegalworkServerClient, "saveStorageConnection" | "removeStorageConnection" | "storageOAuthStatus" | "storageOAuthStart" | "storageOAuthDisconnect">;

/** A new OAuth connection is only complete after the browser sign-in succeeds.
 * The server needs a saved ID for its callback; discard that temporary record
 * if sign-in fails or the user closes the setup dialog. */
export async function saveStorageAndSignIn(client: StorageClient, workspaceId: string, input: StorageInput, options: {
  id?: string; signal: AbortSignal; openLink: (url: string) => unknown; onWaiting: () => void;
}) {
  const { connection } = await client.saveStorageConnection(workspaceId, input, options.id);
  let completed = false;
  let startedSignIn = false;
  try {
    options.signal.throwIfAborted();
    if (input.config.kind === "oauth" && !input.config.accountId && input.enabled) {
      if (!(await client.storageOAuthStatus(workspaceId, connection.id)).connected) {
        startedSignIn = true;
        const flow = await client.storageOAuthStart(workspaceId, connection.id);
        options.signal.throwIfAborted();
        options.onWaiting();
        await options.openLink(flow.authUrl);
        for (;;) {
          options.signal.throwIfAborted();
          const status = await client.storageOAuthStatus(workspaceId, connection.id);
          options.signal.throwIfAborted();
          if (status.connected) break;
          if (status.error || !status.pending) throw new Error(status.error || t("connectors.expired"));
          await new Promise<void>((resolve, reject) => {
            const done = () => { options.signal.removeEventListener("abort", abort); resolve(); };
            const timer = setTimeout(done, 1500);
            const abort = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); reject(options.signal.reason); };
            options.signal.addEventListener("abort", abort, { once: true });
            if (options.signal.aborted) abort();
          });
        }
      }
    }
    options.signal.throwIfAborted();
    completed = true;
    return connection;
  } finally {
    if (!completed) {
      if (!options.id) await client.removeStorageConnection(workspaceId, connection.id);
      else if (startedSignIn) await client.storageOAuthDisconnect(workspaceId, connection.id);
    }
  }
}
