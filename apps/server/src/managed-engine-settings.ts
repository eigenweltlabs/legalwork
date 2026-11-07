import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { z } from "zod";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const entry = z.object({ directory: z.string(), configuration: z.unknown(),
  providerActivation: z.record(z.string(), z.enum(["allow", "deny"])),
  providerModelSelection: z.record(z.string(), z.array(z.string())).optional(),
  projectPermissionApprovals: z.array(z.object({ id: z.string(), action: z.string(), resources: z.array(z.string()), createdAt: z.number(), updatedAt: z.number().optional() }).strict()),
});
export const managedSettingsFileSchema = z.object({ version: z.literal(2), workspaces: z.record(z.string(), entry), sharedConfiguration: z.unknown() });
export type ManagedSettingsFile = z.infer<typeof managedSettingsFileSchema>;
export class ManagedSettingsWorkspaceMissingError extends Error {}
export const managedSettingsRpc = {
  id: "legalwork.managed-settings",
  methods: { refresh: { input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { refreshed: { type: "boolean" } }, required: ["refreshed"], additionalProperties: false } },
    permissionScope: { input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { version: { type: "integer", const: 2 }, directory: { type: "string" }, remembered: { type: "string", const: "legalwork-project" } }, required: ["version", "directory", "remembered"], additionalProperties: false } },
  }, events: {},
} satisfies import("@opencode/schema/rpc").PortableDefinition;

export async function readManagedEngineSettings(path: string, directory: string) {
  const file = managedSettingsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const actual = await realpath(directory).catch(() => resolve(directory));
  let selected: z.infer<typeof entry> | undefined, selectedLength = -1;
  for (const candidate of Object.values(file.workspaces)) {
    const root = await realpath(candidate.directory).catch(() => resolve(candidate.directory));
    const path = relative(root, actual);
    if (path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path) || root.length <= selectedLength) continue;
    selected = candidate; selectedLength = root.length;
  }
  if (!selected) throw new ManagedSettingsWorkspaceMissingError("This engine location is not registered with LegalWork. Register the project before loading managed capabilities.");
  return { ...selected, configuration: Schema.decodeUnknownSync(Config.Info)(selected.configuration, { onExcessProperty: "error" }),
    sharedConfiguration: Schema.decodeUnknownSync(Config.Info)(file.sharedConfiguration, { onExcessProperty: "error" }) };
}
export type ManagedEngineSettings = Awaited<ReturnType<typeof readManagedEngineSettings>>;
