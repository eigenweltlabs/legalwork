import type { MigrationProgress } from "@legalwork/types/migration-progress";
import type { MigrationV1StatusOutput } from "@opencode/client";
import type { ServerConfig } from "./types.js";

export function updateMigrationProgress(config: ServerConfig, change: Partial<MigrationProgress>): void {
  const previous = config.migrationProgress;
  const changedStep = change.phase !== undefined && change.phase !== previous?.phase;
  config.migrationProgress = { status: "running", phase: "history", deferredProjects: 0, ...previous,
    ...(changedStep ? { work: undefined, detail: undefined } : {}), ...change };
}

/** Only publish actual work, throttling chunk updates rather than inventing
 * a timed percentage. Every completed operation flushes its final counter. */
export function migrationWork(config: ServerConfig | undefined, phase: MigrationProgress["phase"], unit: NonNullable<MigrationProgress["work"]>["unit"], total?: number) {
  let completed = 0, publishedAt = 0;
  if (config) updateMigrationProgress(config, { status: "running", phase, work: { completed, unit, total } });
  return {
    advance(amount: number) {
      completed += amount;
      if (config && performance.now() - publishedAt >= 100) {
        publishedAt = performance.now();
        updateMigrationProgress(config, { work: { completed, unit, total } });
      }
    },
    finish() {
      if (config) updateMigrationProgress(config, { work: { completed, unit, total } });
    },
  };
}

export function reportHistoryMigration(config: ServerConfig, status: MigrationV1StatusOutput): void {
  if (status.status === "running") {
    updateMigrationProgress(config, { status: "running", phase: "history", detail: status.progress.label, project: undefined,
      work: status.progress.numerator === undefined ? undefined : { completed: status.progress.numerator, total: status.progress.denominator, unit: "items" } });
  } else if (status.status === "error") {
    updateMigrationProgress(config, { status: "error", phase: "history" });
  }
}
