import { z } from "zod";

const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTP(S) endpoint without credentials, query parameters, or a fragment.");
const prefix = z.string().default("");
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:[\]-]+$/);
const port = z.number().int().min(1).max(65535);
const smbName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^<>:"/\\|?*\x00-\x1f]+$/)
  .refine((v) => !/[. ]$/.test(v) && v !== "." && v !== "..");
const configSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("smb"),
    host,
    port: port.default(445),
    share: smbName,
    prefix,
    domain: z.string().default(""),
    username: z.string().min(1),
    encryption: z.enum(["required", "if-offered"]).default("if-offered"),
  }),
  z.object({ kind: z.literal("webdav"), endpoint, username: z.string().default("") }),
  z.object({
    kind: z.literal("s3"),
    endpoint: endpoint.optional(),
    bucket: z.string().min(1),
    region: z.string().min(1),
    prefix,
    accessKeyId: z.string().default(""),
    forcePathStyle: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("azure"),
    endpoint: endpoint.optional(),
    accountName: z.string().min(1),
    container: z.string().min(1),
    prefix,
  }),
  z.object({
    kind: z.literal("gcs"),
    endpoint: endpoint.optional(),
    projectId: z.string().default(""),
    bucket: z.string().min(1),
    prefix,
  }),
  z.object({
    kind: z.literal("sftp"),
    host,
    port: port.default(22),
    username: z.string().min(1),
    rootPath: z.string().default("/"),
    hostFingerprint: z
      .string()
      .regex(
        /^(?:SHA256:[A-Za-z0-9+/]{43}=?|[a-fA-F0-9]{64})$/,
        "Enter the SHA256 connection fingerprint provided by your IT team.",
      ),
  }),
  z.object({
    kind: z.literal("ftp"),
    host,
    port: port.default(21),
    username: z.string().min(1),
    rootPath: z.string().default("/"),
    security: z.enum(["tls", "implicit", "none"]).default("tls"),
  }),
]);

// These remain under secrets: gateways may require private API keys in headers.
// SDK-managed headers must not override signing, transport or conditional saves.
const reservedHeaders = new Set([
  "authorization",
  "host",
  "date",
  "connection",
  "content-length",
  "content-type",
  "content-encoding",
  "content-md5",
  "transfer-encoding",
  "trailer",
  "te",
  "expect",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "range",
]);
export const storageRequestHeadersSchema = z
  .string()
  .max(16_384)
  .transform((text, ctx) => {
    const headers = new Map<string, string>();
    for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
      const separator = line.indexOf(":");
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (
        separator < 1 ||
        !/^[!#$%&'*+.^_`|~a-z0-9-]+$/.test(name) ||
        /[^\t\x20-\x7e]/.test(line) ||
        !value ||
        headers.has(name) ||
        headers.size >= 20
      ) {
        ctx.addIssue({ code: "custom", message: "Enter up to 20 unique headers, one Name: value per line." });
        return z.NEVER;
      }
      if (reservedHeaders.has(name) || name.startsWith("x-amz-") || name.startsWith("if-")) {
        ctx.addIssue({
          code: "custom",
          message: "Authentication, transport and conditional headers are managed automatically.",
        });
        return z.NEVER;
      }
      headers.set(name, value);
    }
    return Object.fromEntries(headers);
  });

export const storageSecretKeys = [
  "password",
  "privateKey",
  "passphrase",
  "secretAccessKey",
  "sessionToken",
  "requestHeaders",
  "accountKey",
  "sasToken",
  "serviceAccount",
] as const;
export const storageInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  config: configSchema,
  readOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
  // Older shared connections were always installed automatically.
  teamInstallation: z.enum(["automatic", "optional"]).optional(),
  secrets: z
    .partialRecord(z.enum(storageSecretKeys), z.string().max(32_768))
    .superRefine((secrets, ctx) => {
      if (secrets.requestHeaders === undefined) return;
      const result = storageRequestHeadersSchema.safeParse(secrets.requestHeaders);
      if (!result.success)
        for (const issue of result.error.issues)
          ctx.addIssue({ code: "custom", path: ["requestHeaders"], message: issue.message });
    })
    .default({}),
});

export type StorageInput = z.infer<typeof storageInputSchema>;
export type StorageConfig = StorageInput["config"];
export type StorageKind = StorageConfig["kind"];
export type StorageSecretKey = (typeof storageSecretKeys)[number];
export type StorageConnection = Omit<StorageInput, "secrets"> & {
  id: string;
  updatedAt: number;
  configuredSecrets: StorageSecretKey[];
  team?: { orgId: string; version: number; installed: boolean };
};
export type StorageTeamStatus = { connected: boolean; canManage: boolean; error?: string };
export type StorageRoot = { id: string; name: string; kind: StorageKind; writable: boolean; revision?: string };
export type StorageEntry = {
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  modifiedAt: string | null;
};
export type StoragePage = { entries: StorageEntry[]; nextCursor?: string };
/** Literal, case-insensitive metadata search over files, including unopened folders. */
export const storageFilenameSearchSchema = z.object({
  query: z.string().trim().min(1).max(512),
  path: z.string().max(4096).default(""),
  match: z.enum(["filename", "path"]).optional(),
  cursor: z.string().min(1).max(65_536).optional(),
});
export type StorageFilenameSearch = z.infer<typeof storageFilenameSearchSchema>;
export type StorageFilenameSearchPage = StoragePage & { scanned: number; complete: boolean };
export type StorageFile = { dataBase64: string; contentType: string; version: string; writable: boolean };
export type StorageWorkingCopy = {
  localPath: string;
  contentType: string;
  version: string;
  size: number;
  updatedAt: number;
  writable: boolean;
  localWritable: boolean;
};
/** Only legacy inline/base64 responses are bounded; file transfers stream. */
export const STORAGE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const STORAGE_PAGE_SIZE = 100;

/** Provider-native search only; these connections are not a LegalMemory index. */
export const storageSearchModeSchema = z.enum(["path_prefix", "name", "content"]);
export const storageSearchSchema = z.object({
  mode: storageSearchModeSchema,
  query: z.string().min(1).max(512),
  path: z.string().default(""),
  cursor: z.string().min(1).max(16_384).optional(),
});
export type StorageSearchMode = z.infer<typeof storageSearchModeSchema>;
export type StorageSearch = z.infer<typeof storageSearchSchema>;
export type StorageSearchPage = StoragePage & { truncated?: boolean; scope?: "folder" | "subtree"; path?: string };
export type StorageCapabilities = {
  read: boolean;
  write: boolean;
  createFolder: boolean;
  search: { modes: StorageSearchMode[]; pagination: boolean; scope?: "folder" | "subtree" };
};
