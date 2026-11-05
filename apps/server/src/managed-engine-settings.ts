import { Config } from "@opencode/schema/config";
import { Skill } from "@opencode/schema/skill";
import { Schema } from "effect";
import { z } from "zod";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const entry = z.object({ directory: z.string(), configuration: z.unknown(),
  providerActivation: z.record(z.string(), z.enum(["allow", "deny"])),
  modelFilters: z.record(z.string(), z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })),
  agentRequests: z.record(z.string(), z.record(z.string(), z.unknown())),
  skills: z.array(z.unknown()),
});
export const managedSettingsFileSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string(), entry), sharedConfiguration: z.unknown().optional() });
export type ManagedSettingsFile = z.infer<typeof managedSettingsFileSchema>;
export class ManagedSettingsWorkspaceMissingError extends Error {}
export const managedSettingsRpc = {
  id: "legalwork.managed-settings",
  methods: { refresh: { input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { refreshed: { type: "boolean" } }, required: ["refreshed"], additionalProperties: false } } }, events: {},
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
    sharedConfiguration: Schema.decodeUnknownSync(Config.Info)(file.sharedConfiguration ?? {}, { onExcessProperty: "error" }),
    skills: selected.skills.map(skill => Schema.decodeUnknownSync(Skill.Info)(skill)) };
}
export type ManagedEngineSettings = Awaited<ReturnType<typeof readManagedEngineSettings>>;
