import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ContainerClient,
  StorageSharedKeyCredential,
  type ContainerListBlobHierarchySegmentResponse,
} from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import type { StorageInput } from "@legalwork/types/file-storage";
import { STORAGE_PAGE_SIZE } from "./schema.js";
import { ApiError } from "../errors.js";
import {
  collectStream,
  entry,
  missingAsNull,
  objectPrefix,
  type StorageAdapter,
  type WriteCondition,
} from "./common.js";

export function s3Adapter(input: StorageInput): StorageAdapter {
  if (input.config.kind !== "s3") throw new Error("Invalid S3 configuration");
  const config = input.config;
  if (Boolean(config.accessKeyId) !== Boolean(input.secrets.secretAccessKey))
    throw new ApiError(
      400,
      "storage_credentials_required",
      "Enter both an access key ID and secret key, or leave both empty if AWS access is already configured.",
    );
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 2,
    credentials: config.accessKeyId
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: input.secrets.secretAccessKey!,
          sessionToken: input.secrets.sessionToken || undefined,
        }
      : undefined,
  });
  const root = objectPrefix(config.prefix);
  const key = (path: string) => root + path;
  const conditions = (value: WriteCondition) => ({
    IfMatch: value.version,
    IfNoneMatch: value.createOnly ? "*" : undefined,
  });
  const signal = () => ({ abortSignal: AbortSignal.timeout(60_000) });
  return {
    async list(path, cursor) {
      const prefix = key(path ? `${path}/` : "");
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          Delimiter: "/",
          MaxKeys: STORAGE_PAGE_SIZE,
          ContinuationToken: cursor,
        }),
        signal(),
      );
      return {
        entries: [
          ...(page.CommonPrefixes ?? []).flatMap((item) =>
            item.Prefix ? [entry(item.Prefix.slice(root.length).replace(/\/$/, ""), "folder")] : [],
          ),
          ...(page.Contents ?? []).flatMap((item) =>
            item.Key && item.Key !== prefix && !item.Key.endsWith("/")
              ? [
                  entry(
                    item.Key.slice(root.length),
                    "file",
                    item.Size ?? null,
                    item.LastModified?.toISOString() ?? null,
                  ),
                ]
              : [],
          ),
        ],
        nextCursor: page.NextContinuationToken,
      };
    },
    stat: (path) =>
      missingAsNull(async () => {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key(path) }), signal());
        if (!result.ETag) throw new Error("S3 omitted the file version");
        return { size: result.ContentLength ?? 0, version: result.ETag, contentType: result.ContentType };
      }),
    async read(path) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key(path) }), signal());
      if (!result.Body || !result.ETag) throw new Error("S3 omitted the file body or version");
      const data = await collectStream(result.Body.transformToWebStream());
      return { data, size: data.length, version: result.ETag, contentType: result.ContentType };
    },
    async write(path, data, contentType, condition) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key(path),
          Body: data,
          ContentType: contentType,
          ...conditions(condition),
        }),
        signal(),
      );
    },
    async mkdir(path) {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key(`${path}/`), Body: Buffer.alloc(0), IfNoneMatch: "*" }),
        signal(),
      );
    },
    async close() {
      client.destroy();
    },
  };
}

export function azureAdapter(input: StorageInput): StorageAdapter {
  if (input.config.kind !== "azure") throw new Error("Invalid Azure configuration");
  const config = input.config;
  const base = config.endpoint ?? `https://${config.accountName}.blob.core.windows.net`;
  const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(config.container)}`;
  const options = { retryOptions: { maxTries: 2, tryTimeoutInMs: 60_000 } };
  if (!input.secrets.sasToken && !input.secrets.accountKey)
    throw new ApiError(400, "storage_credentials_required", "Provide an Azure account key or a container SAS token.");
  const client = input.secrets.sasToken
    ? new ContainerClient(`${url}?${input.secrets.sasToken.replace(/^\?/, "")}`, undefined, options)
    : new ContainerClient(url, new StorageSharedKeyCredential(config.accountName, input.secrets.accountKey!), options);
  const root = objectPrefix(config.prefix);
  const file = (path: string) => client.getBlockBlobClient(root + path);
  return {
    async list(path, cursor) {
      const prefix = root + (path ? `${path}/` : "");
      const pages = client
        .listBlobsByHierarchy("/", { prefix })
        .byPage({ maxPageSize: STORAGE_PAGE_SIZE, continuationToken: cursor });
      const page: ContainerListBlobHierarchySegmentResponse | undefined = (await pages.next()).value;
      if (!page) return { entries: [] };
      return {
        entries: [
          ...(page.segment.blobPrefixes ?? []).map((item) =>
            entry(item.name.slice(root.length).replace(/\/$/, ""), "folder"),
          ),
          ...page.segment.blobItems
            .filter((item) => item.name !== prefix && !item.name.endsWith("/"))
            .map((item) =>
              entry(
                item.name.slice(root.length),
                "file",
                item.properties.contentLength ?? null,
                item.properties.lastModified?.toISOString() ?? null,
              ),
            ),
        ],
        nextCursor: page.continuationToken || undefined,
      };
    },
    stat: (path) =>
      missingAsNull(async () => {
        const result = await file(path).getProperties();
        if (!result.etag) throw new Error("Azure omitted the file version");
        return { size: result.contentLength ?? 0, version: result.etag, contentType: result.contentType };
      }),
    async read(path) {
      const result = await file(path).download();
      if (!result.readableStreamBody || !result.etag) throw new Error("Azure omitted the file body or version");
      const data = await collectStream(result.readableStreamBody);
      return { data, size: data.length, version: result.etag, contentType: result.contentType };
    },
    async write(path, data, contentType, condition) {
      await file(path).uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifMatch: condition.version, ifNoneMatch: condition.createOnly ? "*" : undefined },
      });
    },
    async mkdir(path) {
      await file(`${path}/`).uploadData(Buffer.alloc(0), { conditions: { ifNoneMatch: "*" } });
    },
  };
}

const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
});
const gcsListSchema = z.object({ prefixes: z.array(z.string()).optional() });

export function gcsAdapter(input: StorageInput): StorageAdapter {
  if (input.config.kind !== "gcs") throw new Error("Invalid GCS configuration");
  const config = input.config;
  let credentials: z.infer<typeof serviceAccountSchema> | undefined;
  if (input.secrets.serviceAccount) {
    try {
      credentials = serviceAccountSchema.parse(JSON.parse(input.secrets.serviceAccount));
    } catch {
      throw new ApiError(400, "storage_credentials_invalid", "Enter a valid Google service-account JSON key.");
    }
  }
  const client = new Storage({
    projectId: config.projectId || credentials?.project_id,
    credentials,
    apiEndpoint: config.endpoint,
    useAuthWithCustomEndpoint: Boolean(config.endpoint && credentials),
    retryOptions: { maxRetries: 1, totalTimeout: 60 },
  });
  const bucket = client.bucket(config.bucket);
  const root = objectPrefix(config.prefix);
  const file = (path: string) => bucket.file(root + path);
  return {
    async list(path, cursor) {
      const prefix = root + (path ? `${path}/` : "");
      const [files, nextQuery, raw] = await bucket.getFiles({
        prefix,
        delimiter: "/",
        maxResults: STORAGE_PAGE_SIZE,
        pageToken: cursor,
        autoPaginate: false,
      });
      const page = gcsListSchema.parse(raw);
      return {
        entries: [
          ...(page.prefixes ?? []).map((name) => entry(name.slice(root.length).replace(/\/$/, ""), "folder")),
          ...files
            .filter((item) => item.name !== prefix && !item.name.endsWith("/"))
            .map((item) =>
              entry(
                item.name.slice(root.length),
                "file",
                item.metadata.size == null ? null : Number(item.metadata.size),
                item.metadata.updated ?? null,
              ),
            ),
        ],
        nextCursor: nextQuery?.pageToken,
      };
    },
    stat: (path) =>
      missingAsNull(async () => {
        const [metadata] = await file(path).getMetadata();
        if (!metadata.generation) throw new Error("GCS omitted the file generation");
        return {
          size: Number(metadata.size ?? 0),
          version: String(metadata.generation),
          contentType: metadata.contentType,
        };
      }),
    async read(path) {
      const [metadata] = await file(path).getMetadata();
      if (!metadata.generation) throw new Error("GCS omitted the file generation");
      // Pin the read to the version whose metadata we return.
      const data = await collectStream(
        bucket.file(root + path, { generation: metadata.generation }).createReadStream(),
      );
      return { data, size: data.length, version: String(metadata.generation), contentType: metadata.contentType };
    },
    async write(path, data, contentType, condition) {
      await file(path).save(data, {
        resumable: false,
        contentType,
        preconditionOpts: { ifGenerationMatch: condition.createOnly ? 0 : condition.version },
      });
    },
    async mkdir(path) {
      await file(`${path}/`).save(Buffer.alloc(0), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    },
  };
}
