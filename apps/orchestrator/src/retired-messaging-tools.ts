import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

/** Retire previously generated bot tools without discarding local edits. */
export async function retireMessagingTools(configDir: string): Promise<void> {
  const archive = join(configDir, "retired-messaging-tools");
  const entries = [
    { directory: "tools", name: "opencode_router_send.ts" },
    { directory: "tools", name: "opencode_router_status.ts" },
    { directory: "plugins", name: "legalwork-messaging-send" },
    { directory: "plugins", name: "legalwork-messaging-status" },
  ];
  await mkdir(archive, { recursive: true });
  for (const { directory, name } of entries) {
    try {
      await rename(
        join(configDir, directory, name),
        join(archive, `${name}.${randomUUID()}.disabled`),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
