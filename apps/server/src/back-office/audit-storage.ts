import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  linkSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { z } from "zod";
import {
  BackOfficeAuditHeadSchema,
  type BackOfficeAuditHead,
} from "./schema.js";
import { newBackOfficeAuditKey } from "./audit-integrity.js";

const IdentitySchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().uuid(),
    userId: z.string().min(1),
    userName: z.string().min(1),
    privateKey: z.string().min(1),
    publicKey: z.string().min(1),
  })
  .strict();
export type BackOfficeAuditIdentity = z.infer<typeof IdentitySchema>;
export type BackOfficeAuditStorage = {
  identity: BackOfficeAuditIdentity;
  persistent: boolean;
  key: (streamId: string) => Buffer | null;
  createKey: (streamId: string) => Buffer;
  eraseKey: (streamId: string) => void;
  head: (streamId: string) => BackOfficeAuditHead | null;
  heads: () => BackOfficeAuditHead[];
  checkpoint: (head: BackOfficeAuditHead) => void;
};

function newIdentity(): BackOfficeAuditIdentity {
  const user = userInfo();
  return {
    version: 1,
    deviceId: randomUUID(),
    userId: `os:${user.uid}:${user.username}`,
    userName: user.username,
    ...newBackOfficeAuditKey(),
  };
}

/** Ephemeral storage is reserved for in-memory database tests. */
export function memoryBackOfficeAuditStorage(): BackOfficeAuditStorage {
  const keys = new Map<string, Buffer>();
  const heads = new Map<string, BackOfficeAuditHead>();
  return {
    identity: newIdentity(),
    persistent: false,
    key: (id) => keys.get(id) ?? null,
    createKey: (id) => {
      const key = keys.get(id) ?? randomBytes(32);
      keys.set(id, key);
      return key;
    },
    eraseKey: (id) => {
      keys.delete(id);
    },
    head: (id) => heads.get(id) ?? null,
    heads: () => [...heads.values()],
    checkpoint: (head) => {
      heads.set(head.streamId, { ...head });
    },
  };
}

/** Persist a checkpoint before acknowledging a write, including its directory entry. */
function durableWrite(
  path: string,
  directory: string,
  value: unknown,
  exclusive = false,
) {
  const staging = `${path}.${randomUUID()}.pending`;
  const descriptor = openSync(staging, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (exclusive) {
      try {
        linkSync(staging, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    } else renameSync(staging, path);
    // Windows does not expose fsync on a directory handle. The file itself is
    // flushed above; POSIX additionally flushes the renamed directory entry.
    if (process.platform !== "win32") {
      const parent = openSync(directory, "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
}

export function fileBackOfficeAuditStorage(
  directory: string,
  existingHistory: boolean,
): BackOfficeAuditStorage {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identityPath = join(directory, "identity.json");
  if (!existsSync(identityPath)) {
    if (existingHistory)
      throw new Error(
        "Back Office audit identity is missing. Restore its secured backup; history cannot be reset automatically.",
      );
    durableWrite(identityPath, directory, newIdentity(), true);
  }
  const identity = IdentitySchema.parse(
    JSON.parse(readFileSync(identityPath, "utf8")),
  );
  const path = (id: string, suffix: string) =>
    join(directory, `${z.string().uuid().parse(id)}.${suffix}.json`);
  return {
    identity,
    persistent: true,
    key: (id) => {
      const keyPath = path(id, "key");
      if (!existsSync(keyPath)) return null;
      const key = Buffer.from(
        z
          .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(JSON.parse(readFileSync(keyPath, "utf8"))).key,
        "hex",
      );
      return key;
    },
    createKey: (id) => {
      const keyPath = path(id, "key");
      if (existsSync(keyPath))
        return Buffer.from(
          z
            .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict()
            .parse(JSON.parse(readFileSync(keyPath, "utf8"))).key,
          "hex",
        );
      const key = randomBytes(32);
      durableWrite(keyPath, directory, { key: key.toString("hex") }, true);
      return Buffer.from(
        z
          .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(JSON.parse(readFileSync(keyPath, "utf8"))).key,
        "hex",
      );
    },
    eraseKey: (id) => {
      const keyPath = path(id, "key");
      if (existsSync(keyPath)) unlinkSync(keyPath);
      if (process.platform !== "win32") {
        const descriptor = openSync(directory, "r");
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
    },
    head: (id) => {
      const headPath = path(id, "head");
      return existsSync(headPath)
        ? BackOfficeAuditHeadSchema.parse(
            JSON.parse(readFileSync(headPath, "utf8")),
          )
        : null;
    },
    heads: () =>
      readdirSync(directory)
        .filter((name) => name.endsWith(".head.json"))
        .map((name) =>
          BackOfficeAuditHeadSchema.parse(
            JSON.parse(readFileSync(join(directory, name), "utf8")),
          ),
        ),
    checkpoint: (raw) => {
      const head = BackOfficeAuditHeadSchema.parse(raw);
      const headPath = path(head.streamId, "head");
      if (existsSync(headPath)) {
        const before = BackOfficeAuditHeadSchema.parse(
          JSON.parse(readFileSync(headPath, "utf8")),
        );
        if (
          before.streamId !== head.streamId ||
          before.publicKey !== head.publicKey ||
          before.sequence > head.sequence ||
          (before.sequence === head.sequence && before.hash !== head.hash)
        )
          throw new Error(
            "Back Office audit checkpoint cannot be replaced by an older or conflicting history.",
          );
      }
      durableWrite(headPath, directory, head);
    },
  };
}
