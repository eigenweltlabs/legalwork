/** Keep a successful deletion across retries of desktop/local cleanup. */
export function createProjectRemoval() {
  let result: { sessionIds: string[]; backupPath?: string | null } | null = null;
  return {
    get deleted() { return result !== null; },
    get backupPath() { return result?.backupPath ?? null; },
    async run(remove: () => Promise<{ sessionIds: string[]; backupPath?: string | null }>, finish: (sessionIds: string[]) => Promise<void>) {
      result ??= await remove();
      await finish(result.sessionIds);
      return result;
    },
  };
}
