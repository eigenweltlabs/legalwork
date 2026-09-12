/** Seed only loopback reference services and an isolated dev LegalWork server. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { zipSync, strToU8 } from "fflate";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import { storageInputSchema, type StorageInput } from "@legalwork/types/file-storage";
import { withStorage } from "../src/file-storage/service.js";

const fixtures = process.env.LEGALWORK_STORAGE_FIXTURES ?? "/tmp/legalwork-storage-fixtures";
const bucket = `legalwork-demo-${Date.now()}`;
const accountKey = Buffer.alloc(32, 7).toString("base64");
const server = "http://127.0.0.1:19287";
const headers = {
  authorization: "Bearer storage-dev-client",
  "x-legalwork-host-token": "storage-dev-owner",
  "content-type": "application/json",
};
const workspaces = z
  .object({ items: z.array(z.object({ id: z.string() })) })
  .parse(await (await fetch(`${server}/workspaces`, { headers })).json());
const workspaceId = workspaces.items[0]?.id;
if (!workspaceId) throw new Error("Start the isolated storage dev server first.");
const existing = z
  .object({ connections: z.array(z.object({ name: z.string() })) })
  .parse(await (await fetch(`${server}/workspace/${workspaceId}/storage`, { headers })).json());
const configs: StorageInput[] = [
  storageInputSchema.parse({
    name: "Test · SMB (Samba)",
    config: {
      kind: "smb",
      host: "127.0.0.1",
      port: 19345,
      share: "documents",
      prefix: "Demo",
      username: "legalwork",
      encryption: "required",
    },
    secrets: { password: "fixture-password" },
  }),
  storageInputSchema.parse({
    name: "Test · S3 (MinIO)",
    config: {
      kind: "s3",
      endpoint: "http://127.0.0.1:19290",
      bucket,
      region: "us-east-1",
      accessKeyId: "legalwork",
      forcePathStyle: true,
      prefix: "lawfirm",
    },
    secrets: { secretAccessKey: "fixture-password" },
  }),
  storageInputSchema.parse({
    name: "Test · Azure (Azurite)",
    config: {
      kind: "azure",
      endpoint: "http://127.0.0.1:19000/legalwork",
      accountName: "legalwork",
      container: bucket,
      prefix: "lawfirm",
    },
    secrets: { accountKey },
  }),
  storageInputSchema.parse({
    name: "Test · Google Cloud (emulator)",
    config: { kind: "gcs", endpoint: "http://127.0.0.1:19444", projectId: "legalwork-test", bucket, prefix: "lawfirm" },
  }),
  storageInputSchema.parse({
    name: "Test · WebDAV",
    config: { kind: "webdav", endpoint: "http://127.0.0.1:19280/Demo", username: "legalwork" },
    secrets: { password: "fixture-password" },
  }),
  storageInputSchema.parse({
    name: "Test · SFTP",
    config: {
      kind: "sftp",
      host: "127.0.0.1",
      port: 19222,
      username: "legalwork",
      rootPath: "/Demo",
      hostFingerprint: (await readFile(join(fixtures, "sftp-fingerprint.txt"), "utf8")).trim(),
    },
    secrets: { password: "fixture-password" },
  }),
  storageInputSchema.parse({
    name: "Test · FTPS",
    config: { kind: "ftp", host: "127.0.0.1", port: 19243, username: "legalwork", rootPath: "/Demo", security: "tls" },
    secrets: { password: "fixture-password" },
    readOnly: true,
  }),
];
const s3 = new S3Client({
  endpoint: "http://127.0.0.1:19290",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "legalwork", secretAccessKey: "fixture-password" },
});
await s3.send(new CreateBucketCommand({ Bucket: bucket }));
s3.destroy();
await new BlobServiceClient(
  "http://127.0.0.1:19000/legalwork",
  new StorageSharedKeyCredential("legalwork", accountKey),
).createContainer(bucket);
await new Storage({ apiEndpoint: "http://127.0.0.1:19444", projectId: "legalwork-test" }).createBucket(bucket);
const docx = Buffer.from(
  zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Draft acquisition agreement</w:t></w:r></w:p><w:p><w:r><w:t>The parties agree to review the terms before signing.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
    ),
  }),
);
const sharedFiles = join(fixtures, "files", "Demo");
await mkdir(join(sharedFiles, "Matters", "Acquisition"), { recursive: true });
await writeFile(join(sharedFiles, "Welcome.txt"), "Connected files are loaded only when you open them.\n");
await writeFile(
  join(sharedFiles, "Matters", "Acquisition", "Deal notes.txt"),
  "Review the draft agreement before Friday.\n",
);
await writeFile(join(sharedFiles, "Matters", "Acquisition", "Draft agreement.docx"), docx);
for (const input of configs) {
  if (existing.connections.some((connection) => connection.name === input.name)) continue;
  if (["s3", "azure", "gcs"].includes(input.config.kind))
    await withStorage(input, async (adapter) => {
      await adapter.mkdir("Matters");
      await adapter.mkdir("Matters/Acquisition");
      await adapter.write("Welcome.txt", Buffer.from("Welcome to the firm's connected storage.\n"), "text/plain", {
        createOnly: true,
      });
      await adapter.write(
        "Matters/Acquisition/Deal notes.txt",
        Buffer.from("Review the draft agreement before Friday.\n"),
        "text/plain",
        { createOnly: true },
      );
      await adapter.write(
        "Matters/Acquisition/Draft agreement.docx",
        docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        { createOnly: true },
      );
    });
  const response = await fetch(`${server}/workspace/${workspaceId}/storage`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Could not add ${input.name}: HTTP ${response.status}`);
  console.log(`Added ${input.name}`);
}
console.log(`Dev app: http://localhost:15273/workspace/${workspaceId}/settings/extensions/storage`);
