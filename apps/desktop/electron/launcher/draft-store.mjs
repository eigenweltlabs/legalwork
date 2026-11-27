import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const profilePattern = /^[a-f0-9]{64}$/;
const metadataLimit = 8 * 1024 * 1024;
const attachmentLimit = 64 * 1024 * 1024;
const empty = () => ({ version: 0, drafts: {}, leases: {} });

function* attachmentFields(file) {
  for (const draft of Object.values(file.drafts ?? {})) {
    const input = draft?.submission?.input;
    if (Array.isArray(input?.parts)) {
      for (const part of input.parts) if (part?.type === "file") yield [part, "url"];
    }
    const attachments = input?.queue?.draft?.attachments;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) if (attachment && typeof attachment === "object") yield [attachment, "data"];
    }
  }
}

async function writeAtomic(target, text) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function createLauncherDraftStore(getDirectory) {
  const writes = new Map();
  function paths(profile) {
    if (typeof profile !== "string" || !profilePattern.test(profile)) throw new Error("Invalid draft profile.");
    const target = path.join(getDirectory(), `launcher-drafts-${profile}.json`);
    return { target, attachments: `${target}.attachments` };
  }

  async function readMetadata(target) {
    let raw;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return empty();
      throw error;
    }
    const file = JSON.parse(raw);
    return {
      version: Number.isSafeInteger(file?.version) ? file.version : 0,
      drafts: file?.drafts && typeof file.drafts === "object" ? file.drafts : {},
      leases: file?.leases && typeof file.leases === "object" ? file.leases : {},
    };
  }

  function serial(profile, work) {
    const operation = (writes.get(profile) ?? Promise.resolve()).catch(() => {}).then(work);
    writes.set(profile, operation);
    const done = () => { if (writes.get(profile) === operation) writes.delete(profile); };
    void operation.then(done, done);
    return operation;
  }

  return {
    read(profile) {
      const { target, attachments } = paths(profile);
      return serial(profile, async () => {
        const file = await readMetadata(target);
        const pending = new Map();
        await Promise.all(Array.from(attachmentFields(file), async ([item, field]) => {
          const id = item[field]?.attachmentId;
          if (typeof id !== "string" || !profilePattern.test(id)) return;
          if (!pending.has(id)) pending.set(id, readFile(path.join(attachments, id), "utf8"));
          // Missing sidecars invalidate only this submission. The renderer recovers its editable draft.
          try { item[field] = await pending.get(id); } catch {}
        }));
        return file;
      });
    },
    write(file, expectedVersion, profile) {
      const { target, attachments } = paths(profile);
      if (!Number.isSafeInteger(expectedVersion) || file?.version !== expectedVersion + 1) throw new Error("Invalid draft update.");
      return serial(profile, async () => {
        if ((await readMetadata(target)).version !== expectedVersion) return false;
        const metadata = structuredClone(file);
        const sidecars = new Map();
        for (const [item, field] of attachmentFields(metadata)) {
          const data = item[field];
          if (typeof data !== "string" || !data.startsWith("data:")) continue;
          if (Buffer.byteLength(data, "utf8") >= attachmentLimit) throw new Error("The attachment is too large to send. Remove it or attach a smaller file.");
          const id = createHash("sha256").update(data).digest("hex");
          sidecars.set(id, data);
          item[field] = { attachmentId: id };
        }
        const snapshot = JSON.stringify(metadata);
        if (Buffer.byteLength(snapshot, "utf8") > metadataLimit) throw new Error("Draft storage is full. Shorten or clear some saved drafts.");
        if (sidecars.size) {
          await mkdir(attachments, { recursive: true, mode: 0o700 });
          const existing = new Set(await readdir(attachments));
          for (const [id, contents] of sidecars) if (!existing.has(id)) await writeAtomic(path.join(attachments, id), contents);
        }
        await writeAtomic(target, snapshot);
        const stored = await readdir(attachments).catch(() => []);
        await Promise.all(stored.filter(id => !sidecars.has(id)).map(id => rm(path.join(attachments, id), { force: true }).catch(() => {})));
        return true;
      });
    },
  };
}
