import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { StorageAdapter } from "../file-storage/common.js";
import { syncProjectFiles } from "../project-file-sync.js";
import type { ProjectSyncStore } from "../project-sync-store.js";

/** Resources reuse project sync's comparison engine AND local file bases.
 * Only availability markers are new; there is no second index/database. */
export class ReplicaResources {
  constructor(private store: ProjectSyncStore, private deviceId: string) {}
  private key(scope: string) { return `personal:${this.deviceId}:${scope}`; }
  isHydrated(scope: string, root: string) {
    const state = this.store.fileRoot(this.key(scope));
    return state?.ready === true && state.root === root && existsSync(root);
  }
  markHydrated(scope: string, root: string) { this.store.setFileRoot(this.key(scope), root, true); }
  initialize(scope: string, root: string) {
    const fresh = this.store.fileRoot(this.key(scope))?.root !== root || !existsSync(root);
    if (fresh) this.store.setFileRoot(this.key(scope), root, false);
    return fresh;
  }
  async sync(remote: StorageAdapter, scope: string, root: string, label: string, allowDeletions = false, includes: (path: string) => boolean = () => true) {
    const key = this.key(scope);
    if (this.initialize(scope, root)) {
      this.store.clearFileBase(key);
      await mkdir(root, { recursive: true });
    }
    const result = await syncProjectFiles({ root, remote, base: this.store.fileBase(key), includes,
      reconcile: true, allowDeletions, label, maxFileBytes: 256 * 1024 * 1024 });
    if (!result.pending && !result.stale) this.markHydrated(scope, root);
    return result;
  }
}
