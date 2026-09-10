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
const configSchema = z.discriminatedUnion("kind", [
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
      .regex(/^(?:SHA256:[A-Za-z0-9+/]{43}=?|[a-fA-F0-9]{64})$/, "Enter the SHA256 connection fingerprint provided by your IT team."),
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

export const storageSecretKeys = [
  "password",
  "privateKey",
  "passphrase",
  "secretAccessKey",
  "sessionToken",
  "accountKey",
  "sasToken",
  "serviceAccount",
] as const;
export const storageInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  config: configSchema,
  readOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
  secrets: z.partialRecord(z.enum(storageSecretKeys), z.string().max(32_768)).default({}),
});

export type StorageInput = z.infer<typeof storageInputSchema>;
export type StorageConfig = StorageInput["config"];
export type StorageKind = StorageConfig["kind"];
export type StorageSecretKey = (typeof storageSecretKeys)[number];
export type StorageConnection = Omit<StorageInput, "secrets"> & {
  id: string;
  updatedAt: number;
  configuredSecrets: StorageSecretKey[];
};
export type StorageRoot = { id: string; name: string; kind: StorageKind; writable: boolean };
export type StorageEntry = {
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  modifiedAt: string | null;
};
export type StoragePage = { entries: StorageEntry[]; nextCursor?: string };
export type StorageFile = { dataBase64: string; contentType: string; version: string; writable: boolean };
export const STORAGE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const STORAGE_PAGE_SIZE = 100;
