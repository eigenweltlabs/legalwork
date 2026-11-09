/** Authenticated, in-memory startup progress. Counts describe the current step,
 * not elapsed time or a prediction of remaining work. */
export type MigrationProgress = {
  status: "running" | "complete" | "waiting" | "error";
  phase: "history" | "inspecting" | "copying" | "verifying" | "finding-chats" | "chats" | "references" | "backup" | "finishing";
  detail?: string;
  project?: { name: string; index: number; total: number };
  work?: { completed: number; total?: number; unit: "bytes" | "files" | "chats" | "items" };
  deferredProjects: number;
};

export type MigrationProgressResponse = { migration: MigrationProgress | null };
