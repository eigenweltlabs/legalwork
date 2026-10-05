import { z } from "zod";

/**
 * Org policies: settings and permissions a firm's admin sets on the platform
 * for every member, which LegalWork enforces while the member is signed in to
 * that firm. Versioned wire contract shared by the platform and LegalWork:
 * this file is mirrored as model-api `packages/shared/src/org-policy.ts`;
 * update both together.
 *
 * Every setting is one key in `orgPolicyDefinitions`. An entry has a value
 * and a mode:
 * - `enforced`: locked while signed in. After sign-out the value stays, and
 *   the member may change it after confirming.
 * - `default`: applied until the member changes it.
 * A key without an entry is not managed. To add a key, add its definition;
 * older apps ignore keys they do not know, and an invalid value of one key
 * never affects the others.
 */

export const ORG_POLICY_SCHEMA_VERSION = 1;

export const OrgPolicyModeSchema = z.enum(["enforced", "default"]);
export type OrgPolicyMode = z.infer<typeof OrgPolicyModeSchema>;

/**
 * Where a key takes effect: `app` in the app window, `server` in the
 * LegalWork server's routes, `engine` in the engine's config (a change
 * reloads idle engines).
 */
export type OrgPolicyScope = "app" | "server" | "engine";
export type OrgPolicySection =
  | "security"
  | "connectors"
  | "ai"
  | "branding"
  | "privacy"
  | "sharing"
  | "updates"
  | "workspace";

/** Org-defined providers and engines are prefixed so they never collide with built-in ids. */
const orgId = z.string().regex(/^org-[a-z0-9][a-z0-9-]{0,59}$/);
/** Names an encrypted value kept by the platform; never the value itself. */
export const OrgPolicySecretRefSchema = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,127}$/);
const secretRef = OrgPolicySecretRefSchema.nullable();
const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Use an HTTPS URL without credentials or a fragment.");
const name = z.string().trim().min(1).max(120);
const hubItemIds = z.array(z.string().min(1).max(100)).max(100);

export const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;
/** A plain action, or glob pattern → action rules with "*" as the fallback (engine `permission` format). */
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string().min(1).max(512), PermissionActionSchema),
]);
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
/** The tools of Settings → Safety, plus authorized folders (`external_directory`). */
export const ORG_POLICY_PERMISSION_TOOLS = ["edit", "bash", "webfetch", "doom_loop", "external_directory"] as const;
export type OrgPolicyPermissionTool = (typeof ORG_POLICY_PERMISSION_TOOLS)[number];
const ToolPermissionsSchema = z.strictObject({
  edit: PermissionRuleSchema.optional(),
  bash: PermissionRuleSchema.optional(),
  webfetch: PermissionRuleSchema.optional(),
  doom_loop: PermissionRuleSchema.optional(),
  external_directory: PermissionRuleSchema.optional(),
});

const OrgModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: name.optional(),
  contextLimit: z.number().int().positive().optional(),
  outputLimit: z.number().int().positive().optional(),
});
/** An OpenAI-compatible chat provider for every member. */
export const OrgChatProviderSchema = z.strictObject({
  id: orgId,
  name,
  baseURL: httpsUrl,
  /** The endpoint it speaks: `/chat/completions` (default) or `/responses` (OpenAI, Azure OpenAI). */
  apiType: z.enum(["chat", "responses"]).optional(),
  models: z.array(OrgModelSchema).min(1).max(200),
  secretRef,
});
export type OrgChatProvider = z.infer<typeof OrgChatProviderSchema>;
const ModelChoiceSchema = z.strictObject({
  providerID: z.string().min(1).max(100),
  modelID: z.string().min(1).max(200),
});

const SystemOneQuestionTypeSchema = z.enum(["noul", "choice", "score"]);
export const OrgSystemOneProviderSchema = z.strictObject({
  id: orgId,
  name,
  endpoint: httpsUrl,
  models: z.array(z.strictObject({
    id: z.string().trim().min(1).max(200),
    name,
    questionTypes: z.array(SystemOneQuestionTypeSchema).min(1),
  })).min(1).max(200),
  secretRef,
});
export type OrgSystemOneProvider = z.infer<typeof OrgSystemOneProviderSchema>;

export const OrgOcrEngineSchema = z.strictObject({
  id: orgId,
  label: name,
  kind: z.enum(["chat-completions", "mistral-ocr", "paddleocr"]),
  model: z.string().trim().min(1).max(200),
  /** Full endpoint, not a provider base URL. */
  endpoint: httpsUrl,
  secretRef: OrgPolicySecretRefSchema,
});
export type OrgOcrEngine = z.infer<typeof OrgOcrEngineSchema>;

const BrandingSchema = z.strictObject({
  appName: z.string().trim().min(1).max(60).optional(),
  sidebarBrandName: z.string().trim().min(1).max(60).optional(),
  /** An image data URL, shown in the sidebar. */
  logoDataUrl: z.string().max(400_000).regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/).optional(),
});

const ReviewModelSchema = z.strictObject({ providerId: z.string().min(1), model: z.string().min(1) });
const ReviewDefaultsSchema = z.strictObject({
  mode: z.enum(["jev", "mixed", "llm"]).optional(),
  jev: ReviewModelSchema.optional(),
  llm: ReviewModelSchema.optional(),
  minDecisionProbability: z.number().min(0.5).max(1).optional(),
  ocr: z.enum(["always", "missing-text"]).optional(),
});

type OrgPolicyDefinition = {
  section: OrgPolicySection;
  scope: OrgPolicyScope;
  modes: readonly OrgPolicyMode[];
  schema: z.ZodType;
};

const enforced = ["enforced"] as const;
const both = ["enforced", "default"] as const;

/** The catalog of keys. Ids are never renamed; a removed key is ignored by apps that still know it. */
export const orgPolicyDefinitions = {
  /** Enforced = the minimum: the member's own rule applies where it is stricter. */
  "tools.permissions": { section: "security", scope: "engine", modes: both, schema: ToolPermissionsSchema },

  /** Firm Hub connectors installed for every member; members cannot remove them. */
  "connectors.managed": { section: "connectors", scope: "engine", modes: enforced, schema: hubItemIds },
  "connectors.allowCustom": { section: "connectors", scope: "engine", modes: enforced, schema: z.boolean() },
  /** Firm Hub plugins installed for every member. */
  "plugins.managed": { section: "connectors", scope: "engine", modes: enforced, schema: hubItemIds },
  "plugins.allowCustom": { section: "connectors", scope: "engine", modes: enforced, schema: z.boolean() },
  /** Firm Hub skills and workflows installed for every member. */
  "skills.managed": { section: "connectors", scope: "engine", modes: enforced, schema: hubItemIds },
  "skills.allowCustom": { section: "connectors", scope: "server", modes: enforced, schema: z.boolean() },
  /** Team storage stays in the platform's storage catalog; this decides personal connections. */
  "storage.allowPersonal": { section: "connectors", scope: "server", modes: enforced, schema: z.boolean() },

  "ai.chat.providers": { section: "ai", scope: "engine", modes: enforced, schema: z.array(OrgChatProviderSchema).max(20) },
  "ai.chat.model": { section: "ai", scope: "app", modes: both, schema: ModelChoiceSchema },
  "ai.systemOne.providers": { section: "ai", scope: "server", modes: enforced, schema: z.array(OrgSystemOneProviderSchema).max(10) },
  "ai.systemOne.model": { section: "ai", scope: "server", modes: both, schema: z.strictObject({ providerId: z.string().min(1), model: z.string().min(1) }) },
  "ai.ocr.engines": { section: "ai", scope: "server", modes: enforced, schema: z.array(OrgOcrEngineSchema).max(10) },
  "ai.ocr.defaultEngine": { section: "ai", scope: "server", modes: both, schema: z.string().min(1).max(64) },
  /** Whether members may add their own providers, for chat, SystemOne and OCR. */
  "ai.allowCustomProviders": { section: "ai", scope: "engine", modes: enforced, schema: z.boolean() },

  "branding": { section: "branding", scope: "app", modes: both, schema: BrandingSchema },
  /** Enforced only as false: admins may switch sharing off, never force it on. */
  "privacy.shareAnonymousUsage": { section: "privacy", scope: "app", modes: both, schema: z.boolean() },

  "sharing.projects": { section: "sharing", scope: "server", modes: enforced, schema: z.strictObject({ allow: z.boolean(), allowFirmWide: z.boolean() }) },
  "hub.whoCanShare": { section: "sharing", scope: "server", modes: enforced, schema: z.enum(["members", "admins"]) },

  /** Built-in extensions by id; false switches one off. */
  "extensions.builtIn": { section: "workspace", scope: "app", modes: enforced, schema: z.strictObject({ "computer-use": z.boolean().optional(), "google-workspace": z.boolean().optional() }) },
  /** Added to every agent's instructions, after the member's own. */
  "personalization.firmInstructions": { section: "workspace", scope: "engine", modes: enforced, schema: z.string().trim().min(1).max(12_000) },
  "reviews.defaults": { section: "workspace", scope: "server", modes: both, schema: ReviewDefaultsSchema },
  "language": { section: "workspace", scope: "app", modes: both, schema: z.enum(["en", "de"]) },

  "updates.channel": { section: "updates", scope: "app", modes: both, schema: z.enum(["stable", "alpha"]) },
  "updates.autoCheck": { section: "updates", scope: "app", modes: both, schema: z.boolean() },
  /** Downloading needs checking: enforcing it on also enforces `updates.autoCheck` on. */
  "updates.autoDownload": { section: "updates", scope: "app", modes: both, schema: z.boolean() },
} as const satisfies Record<string, OrgPolicyDefinition>;

type Definitions = typeof orgPolicyDefinitions;
export type OrgPolicyKey = keyof Definitions;
export type OrgPolicyValue<K extends OrgPolicyKey> = z.infer<Definitions[K]["schema"]>;
export type OrgPolicyEntry<K extends OrgPolicyKey> = { mode: OrgPolicyMode; value: OrgPolicyValue<K> };
export type OrgPolicyEntries = { [K in OrgPolicyKey]?: OrgPolicyEntry<K> };

export const ORG_POLICY_KEYS = Object.keys(orgPolicyDefinitions).filter(isOrgPolicyKey);

export function isOrgPolicyKey(key: string): key is OrgPolicyKey {
  return Object.hasOwn(orgPolicyDefinitions, key);
}

function entryIssue(key: OrgPolicyKey, mode: OrgPolicyMode, value: unknown): string | null {
  const definition: OrgPolicyDefinition = orgPolicyDefinitions[key];
  if (!definition.modes.includes(mode)) return `${key} cannot be ${mode}`;
  if (!definition.schema.safeParse(value).success) return `${key} has an invalid value`;
  if (key === "privacy.shareAnonymousUsage" && mode === "enforced" && value !== false)
    return "Anonymous usage sharing can only be enforced off";
  return null;
}

const RawEntrySchema = z.object({ mode: OrgPolicyModeSchema, value: z.unknown() });

/**
 * The valid entries of a policy as received. Unknown keys (from a newer
 * platform) and invalid entries are left out one by one.
 */
export function parseOrgPolicyEntries(input: unknown): OrgPolicyEntries {
  const record = z.record(z.string(), z.unknown()).safeParse(input);
  if (!record.success) return {};
  const entries: Record<string, { mode: OrgPolicyMode; value: unknown }> = {};
  for (const [key, raw] of Object.entries(record.data)) {
    if (!isOrgPolicyKey(key)) continue;
    const entry = RawEntrySchema.safeParse(raw);
    if (!entry.success || entryIssue(key, entry.data.mode, entry.data.value)) continue;
    entries[key] = { mode: entry.data.mode, value: orgPolicyDefinitions[key].schema.parse(entry.data.value) };
  }
  return narrowEntries(entries);
}

// The loop above checked each value against its key's schema.
function narrowEntries(entries: Record<string, unknown>): OrgPolicyEntries {
  return entries as OrgPolicyEntries;
}

/** Problems that keep an admin's policy from being saved; empty when it is valid. */
export function orgPolicyIssues(input: unknown): string[] {
  const record = z.record(z.string(), z.unknown()).safeParse(input);
  if (!record.success) return ["The policy must be an object"];
  const issues: string[] = [];
  for (const [key, raw] of Object.entries(record.data)) {
    if (!isOrgPolicyKey(key)) {
      issues.push(`Unknown setting ${key}`);
      continue;
    }
    const entry = RawEntrySchema.safeParse(raw);
    const issue = entry.success ? entryIssue(key, entry.data.mode, entry.data.value) : `${key} needs a mode and a value`;
    if (issue) issues.push(issue);
  }
  const entries = parseOrgPolicyEntries(record.data);
  const download = entries["updates.autoDownload"];
  const check = entries["updates.autoCheck"];
  if (download?.mode === "enforced" && download.value && !(check?.mode === "enforced" && check.value))
    issues.push("Enforcing automatic downloads also needs automatic update checks enforced on");
  const ids = [
    ...(entries["ai.chat.providers"]?.value ?? []).map((provider) => provider.id),
    ...(entries["ai.systemOne.providers"]?.value ?? []).map((provider) => provider.id),
    ...(entries["ai.ocr.engines"]?.value ?? []).map((engine) => engine.id),
  ];
  if (new Set(ids).size !== ids.length) issues.push("Provider and engine ids must be unique");
  return issues;
}

/** The secrets a policy refers to. */
export function orgPolicySecretRefs(entries: OrgPolicyEntries): string[] {
  const refs = [
    ...(entries["ai.chat.providers"]?.value ?? []).map((provider) => provider.secretRef),
    ...(entries["ai.systemOne.providers"]?.value ?? []).map((provider) => provider.secretRef),
    ...(entries["ai.ocr.engines"]?.value ?? []).map((engine) => engine.secretRef),
  ];
  return [...new Set(refs.filter((ref): ref is string => ref !== null))];
}

/**
 * GET /api/desktop/policy (desktop token): the policy as it applies to the
 * signed-in member. `revision` 0 means the firm has none. With
 * `If-None-Match: "<revision>"` an unchanged policy answers 304.
 */
export const OrgPolicySnapshotSchema = z.object({
  schemaVersion: z.literal(ORG_POLICY_SCHEMA_VERSION),
  orgId: z.string().min(1),
  orgName: z.string(),
  revision: z.number().int().min(0),
  role: z.enum(["admin", "member"]),
  updatedAt: z.string().nullable(),
  /** Parse with `parseOrgPolicyEntries`. */
  entries: z.unknown(),
});
export type OrgPolicySnapshot = Omit<z.infer<typeof OrgPolicySnapshotSchema>, "entries"> & { entries: OrgPolicyEntries };

/** GET /api/desktop/policy/secrets (desktop token): the values of the secrets the policy refers to. */
export const OrgPolicySecretsSchema = z.object({
  schemaVersion: z.literal(ORG_POLICY_SCHEMA_VERSION),
  revision: z.number().int().min(0),
  secrets: z.record(OrgPolicySecretRefSchema, z.string().min(1).max(64 * 1024)),
});
export type OrgPolicySecrets = z.infer<typeof OrgPolicySecretsSchema>;

/** GET /api/org-policy (admin session): what the Policies page edits. Secret values never leave the platform. */
export type OrgPolicyAdminView = {
  schemaVersion: typeof ORG_POLICY_SCHEMA_VERSION;
  revision: number;
  entries: OrgPolicyEntries;
  configuredSecrets: string[];
  canManage: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

/**
 * PUT /api/org-policy (admin session): replaces the whole policy. A stale
 * `revision` answers 409. `secrets` sets (string) or removes (null) values;
 * secrets the policy no longer refers to are removed.
 */
export const OrgPolicyUpdateSchema = z.object({
  revision: z.number().int().min(0),
  entries: z.record(z.string(), z.unknown()),
  secrets: z.record(OrgPolicySecretRefSchema, z.string().min(1).max(64 * 1024).nullable()).optional(),
});
export type OrgPolicyUpdate = z.infer<typeof OrgPolicyUpdateSchema>;
