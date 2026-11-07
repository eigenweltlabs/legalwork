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
  BACK_OFFICE_AUDIT_GENESIS,
  type BackOfficeAuditHead,
} from "./schema.js";
import { newBackOfficeAuditKey } from "./audit-integrity.js";
import { openSqlite } from "../runtime-db.js";

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
  serialized: boolean;
  acquire: () => void;
  release: () => void;
  retain: () => () => void;
  key: (streamId: string) => Buffer | null;
  createKey: (streamId: string) => Buffer;
  eraseKey: (streamId: string) => void;
  discardUncommittedStream: (streamId: string) => void;
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
  const identity = newIdentity();
  return {
    identity,
    persistent: false,
    serialized: true,
    acquire: () => {},
    release: () => {},
    retain: () => () => {},
    key: (id) => keys.get(id) ?? null,
    createKey: (id) => {
      const key = keys.get(id) ?? randomBytes(32);
      keys.set(id, key);
      return key;
    },
    eraseKey: (id) => {
      keys.delete(id);
    },
    discardUncommittedStream: (id) => {
      assertUncommittedHead(heads.get(id) ?? null, id, identity.publicKey);
      heads.delete(id);
      keys.delete(id);
    },
    head: (id) => heads.get(id) ?? null,
    heads: () => [...heads.values()],
    checkpoint: (head) => {
      heads.set(head.streamId, { ...head });
    },
  };
}

function assertUncommittedHead(head: BackOfficeAuditHead | null, id: string, publicKey: string) {
  if (head && (head.streamId !== id || head.sequence !== 0 || head.hash !== BACK_OFFICE_AUDIT_GENESIS || head.publicKey !== publicKey))
    throw new Error("Uncommitted Back Office stream has non-genesis checkpoint evidence. Preserve it before recovery.");
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
    if (
      existingHistory ||
      readdirSync(directory).some((name) => name.endsWith(".head.json"))
    )
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
    serialized: false,
    acquire: () => {},
    release: () => {},
    retain: () => () => {},
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
    discardUncommittedStream: (id) => {
      const headPath = path(id, "head");
      const head = existsSync(headPath) ? BackOfficeAuditHeadSchema.parse(JSON.parse(readFileSync(headPath, "utf8"))) : null;
      assertUncommittedHead(head, id, identity.publicKey);
      // Only called after SQLite has confirmed rollback of this process's
      // newly created stream. Never remove an acknowledged checkpoint.
      if (existsSync(headPath)) unlinkSync(headPath);
      const keyPath = path(id, "key");
      if (existsSync(keyPath)) unlinkSync(keyPath);
      if (process.platform !== "win32") {
        const descriptor = openSync(directory, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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

/** One SQLite write lock spans the business commit and checkpoint fsync. */
export async function openBackOfficeAuditStorage(
  directory: string,
  existingHistory: boolean,
): Promise<BackOfficeAuditStorage> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const mutex = await openSqlite(join(directory, "coordination.sqlite"));
  mutex.exec("PRAGMA busy_timeout=10000");
  let depth = 0,
    references = 0,
    closed = false;
  const acquire = () => {
    if (closed) throw new Error("Back Office audit coordinator is closed.");
    if (depth === 0) mutex.exec("BEGIN IMMEDIATE");
    depth++;
  };
  const release = () => {
    if (depth < 1)
      throw new Error("Back Office audit coordinator is not locked.");
    if (--depth === 0) {
      try {
        mutex.exec("COMMIT");
      } catch (error) {
        mutex.exec("ROLLBACK");
        throw error;
      }
    }
  };
  let files: BackOfficeAuditStorage;
  try {
    acquire();
    try {
      files = fileBackOfficeAuditStorage(directory, existingHistory);
    } finally {
      release();
    }
  } catch (error) {
    mutex.close();
    throw error;
  }
  return {
    ...files,
    serialized: true,
    acquire,
    release,
    retain: () => {
      if (closed) throw new Error("Back Office audit coordinator is closed.");
      references++;
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        if (--references === 0) {
          mutex.close();
          closed = true;
        }
      };
    },
  };
}
