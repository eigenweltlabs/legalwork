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
/** The section of the platform that sets a key: Policies, then Default settings. */
export type OrgPolicySection =
  | "permissions"
  | "ai"
  | "integrations"
  | "features"
  | "sharing"
  | "privacy"
  | "updates"
  | "personalisation"
  | "reviews"
  | "customization"
  | "language"
  | "notifications";

export const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;
/** A plain action, or glob pattern → action rules with "*" as the fallback (engine `permission` format). */
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string().min(1).max(512), PermissionActionSchema),
]);
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
/** The tools of Settings → Safety, plus authorized folders (`external_directory`). */
export const ORG_POLICY_PERMISSION_TOOLS = ["edit", "bash", "external_directory"] as const;
export type OrgPolicyPermissionTool = (typeof ORG_POLICY_PERMISSION_TOOLS)[number];
const ToolPermissionsSchema = z.strictObject({
  edit: PermissionRuleSchema.optional(),
  bash: PermissionRuleSchema.optional(),
  external_directory: PermissionRuleSchema.optional(),
});

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

/** Task notifications, as in Settings → Notifications; a field left out stays the member's. */
const NotificationsSchema = z.strictObject({
  arrivals: z.boolean().optional(),
  dueToday: z.boolean().optional(),
  overdue: z.boolean().optional(),
  scope: z.enum(["mine", "unassigned", "all"]).optional(),
  system: z.boolean().optional(),
  appBadge: z.boolean().optional(),
});

type OrgPolicyDefinition = {
  section: OrgPolicySection;
  scope: OrgPolicyScope;
  modes: readonly OrgPolicyMode[];
  schema: z.ZodType;
};

const enforced = ["enforced"] as const;
const both = ["enforced", "default"] as const;

/**
 * The catalog of keys: the settings of the platform's Policies page (enforced
 * only), then of its Default settings page (enforced or a default). Ids are
 * never renamed; a removed key is ignored by apps that still know it.
 */
export const orgPolicyDefinitions = {
  /** The minimum: the member's own rule applies where it is stricter. */
  "tools.permissions": { section: "permissions", scope: "engine", modes: enforced, schema: ToolPermissionsSchema },

  /** Whether members may add their own chat providers, SystemOne providers and OCR engines. */
  "ai.chat.allowCustom": { section: "ai", scope: "engine", modes: enforced, schema: z.boolean() },
  "ai.systemOne.allowCustom": { section: "ai", scope: "server", modes: enforced, schema: z.boolean() },
  "ai.ocr.allowCustom": { section: "ai", scope: "server", modes: enforced, schema: z.boolean() },

  "connectors.allowCustom": { section: "integrations", scope: "engine", modes: enforced, schema: z.boolean() },
  "plugins.allowCustom": { section: "integrations", scope: "engine", modes: enforced, schema: z.boolean() },
  "skills.allowCustom": { section: "integrations", scope: "server", modes: enforced, schema: z.boolean() },
  /** Team storage stays in the platform's storage catalog; this decides personal connections. */
  "storage.allowPersonal": { section: "integrations", scope: "server", modes: enforced, schema: z.boolean() },

  /** Whether members may use the recorder, install the Office add-ins and run evaluations. */
  "recorder.allow": { section: "features", scope: "app", modes: enforced, schema: z.boolean() },
  "officeAddins.allow": { section: "features", scope: "app", modes: enforced, schema: z.boolean() },
  "evaluations.allow": { section: "features", scope: "app", modes: enforced, schema: z.boolean() },
  /** Built-in extensions by id; false switches one off. */
  "extensions.builtIn": { section: "features", scope: "app", modes: enforced, schema: z.strictObject({ "computer-use": z.boolean().optional(), "google-workspace": z.boolean().optional() }) },

  "sharing.projects": { section: "sharing", scope: "server", modes: enforced, schema: z.strictObject({ allow: z.boolean() }) },
  "hub.whoCanShare": { section: "sharing", scope: "server", modes: enforced, schema: z.enum(["members", "admins"]) },

  /** Only false: admins may switch sharing off, never force it on. */
  "privacy.shareAnonymousUsage": { section: "privacy", scope: "app", modes: enforced, schema: z.boolean() },

  "updates.channel": { section: "updates", scope: "app", modes: enforced, schema: z.enum(["stable", "alpha"]) },
  "updates.autoCheck": { section: "updates", scope: "app", modes: enforced, schema: z.boolean() },
  /** Downloading needs checking: enforcing it on also enforces `updates.autoCheck` on. */
  "updates.autoDownload": { section: "updates", scope: "app", modes: enforced, schema: z.boolean() },

  /** Added to every agent's instructions, after the member's own. */
  "personalization.firmInstructions": { section: "personalisation", scope: "engine", modes: enforced, schema: z.string().trim().min(1).max(12_000) },
  /** The tone of the agents' answers, as in Settings → Personalisation. */
  "personalization.personality": { section: "personalisation", scope: "server", modes: both, schema: z.enum(["pragmatic", "professional", "friendly", "candid"]) },
  "reviews.defaults": { section: "reviews", scope: "server", modes: both, schema: ReviewDefaultsSchema },
  "branding": { section: "customization", scope: "app", modes: both, schema: BrandingSchema },
  "language": { section: "language", scope: "app", modes: both, schema: z.enum(["en", "de"]) },
  "notifications": { section: "notifications", scope: "app", modes: both, schema: NotificationsSchema },
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
  if (key === "privacy.shareAnonymousUsage" && value !== false)
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
  if (download?.value && !check?.value)
    issues.push("Enforcing automatic downloads also needs automatic update checks enforced on");
  return issues;
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

/** GET /api/org-policy (admin session): what the Policies and Default settings pages edit. */
export type OrgPolicyAdminView = {
  schemaVersion: typeof ORG_POLICY_SCHEMA_VERSION;
  revision: number;
  entries: OrgPolicyEntries;
  canManage: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

/** PUT /api/org-policy (admin session): replaces the whole policy. A stale `revision` answers 409. */
export const OrgPolicyUpdateSchema = z.object({
  revision: z.number().int().min(0),
  entries: z.record(z.string(), z.unknown()),
});
export type OrgPolicyUpdate = z.infer<typeof OrgPolicyUpdateSchema>;
