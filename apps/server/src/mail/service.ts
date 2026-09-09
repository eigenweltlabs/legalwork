import { MailWorkerClient, type MailWorkerOptions } from "./runtime/client.js";
import type { WorkerCommand, WorkerResult } from "./runtime/protocol.js";
import { MailServiceError, type MailPageInput, type MailService, type MailServiceStatus } from "./service-interface.js";

export type LocalMailServiceOptions = Pick<MailWorkerOptions, "executable" | "entryPoint"> & {
  databasePath: string;
  /** Stable trusted principal for this local store, never a request property. */
  ownerId: string;
  /** Main process OS vault callback. Called only on unlock/restart, never startup. */
  loadKey: () => Promise<Uint8Array>;
};
function serviceError(error: unknown): MailServiceError {
  if (error instanceof MailServiceError) return error;
  if (error instanceof Error) {
    if (error.message === "mail_worker_not_found") return new MailServiceError("not_found");
    if (error.message === "mail_worker_response_too_large") return new MailServiceError("too_large");
  }
  return new MailServiceError("unavailable");
}

/** One lazy worker and owner per local store. Lock closes the encrypted connection. */
export class LocalMailService implements MailService {
  private readonly worker: MailWorkerClient;
  private phase: "locked" | "unlocking" | "open" | "locking" = "locked";
  private stopped = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;

  constructor(options: LocalMailServiceOptions) {
    this.worker = new MailWorkerClient({
      executable: options.executable, entryPoint: options.entryPoint,
      initialize: async () => {
        const key = await options.loadKey();
        try {
          if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new MailServiceError("unavailable");
          return { ownerId: options.ownerId, databasePath: options.databasePath, encryptionKey: Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString("base64") };
        } finally { if (key instanceof Uint8Array) key.fill(0); }
      },
    });
  }
  status(): MailServiceStatus {
    let state: MailServiceStatus["state"];
    if (this.stopped) state = "stopped";
    else if (this.phase === "open") state = this.worker.status().state === "ready" ? "ready" : "unavailable";
    else state = this.phase;
    return { protocolVersion: 1, state, syncSupported: false };
  }
  unlock(): Promise<void> {
    if (this.stopped) return Promise.reject(new MailServiceError("unavailable"));
    if (this.closing) return Promise.reject(new MailServiceError("locked"));
    if (this.opening) return this.opening;
    if (this.status().state === "ready") return Promise.resolve();
    // An explicit retry from unavailable first tears down any failed generation.
    this.phase = "unlocking";
    const attempt = (async () => {
      try {
        if (this.worker.status().state !== "stopped") await this.worker.stop();
        if (this.phase !== "unlocking" || this.stopped) throw new MailServiceError("locked");
        await this.worker.start();
        if (this.phase !== "unlocking" || this.stopped) throw new MailServiceError("locked");
        this.phase = "open";
      } catch (error) {
        await this.worker.stop();
        if (this.phase === "unlocking") this.phase = "locked";
        throw serviceError(error);
      }
    })();
    this.opening = attempt;
    void attempt.finally(() => { if (this.opening === attempt) this.opening = undefined; }).catch(() => {});
    return attempt;
  }
  lock(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = "locking"; // Reject new operations before awaiting child cleanup.
    const opening = this.opening;
    const closing = (async () => {
      await this.worker.stop();
      await opening?.catch(() => {});
      this.phase = "locked";
    })();
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = undefined; }).catch(() => {});
    return closing;
  }
  private async request(command: WorkerCommand): Promise<WorkerResult> {
    if (this.stopped) throw new MailServiceError("unavailable");
    if (this.phase !== "open") throw new MailServiceError("locked");
    try { return await this.worker.request(command); }
    catch (error) { throw serviceError(error); }
  }
  async listAccounts(page: MailPageInput) {
    const result = await this.request({ operation: "mail.accounts.list", ...page });
    if (!("accounts" in result)) throw new MailServiceError("unavailable");
    return { items: result.accounts, nextCursor: result.nextCursor };
  }
  async listFolders(accountId: string, page: MailPageInput) {
    const result = await this.request({ operation: "mail.folders.list", accountId, ...page });
    if (!("folders" in result)) throw new MailServiceError("unavailable");
    return { items: result.folders, nextCursor: result.nextCursor };
  }
  stop(): Promise<void> {
    this.stopped = true;
    return this.lock();
  }
}
