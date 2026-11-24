import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestRecorderServer } from "./audio/recorder-server-request.mjs";

const route = "/private-timesheet/meeting-recording";

export function createWorkdayRecordingReporter({ directory, serverInfo, request = requestRecorderServer }) {
  let flushing;
  async function host() {
    const info = await serverInfo();
    if (!info?.running || !info.hostToken || !info.baseUrl) return;
    const url = new URL(info.baseUrl);
    if (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return info;
  }
  async function consent(info) {
    if (!info) return;
    const state = await request(info, route, undefined, AbortSignal.timeout(1500));
    if (/^[a-f0-9]{64}$/.test(state.profileId) && Number.isSafeInteger(state.epoch) && typeof state.enabled === "boolean") return state;
  }
  async function currentConsent() {
    return consent(await host());
  }
  async function drain() {
    const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    if (!names.length) return;
    const info = await host();
    const current = await consent(info);
    if (!current) return;
    for (const name of names.filter(name => name.startsWith(current.profileId + ".") && name.endsWith(".json"))) {
      const target = join(directory, name);
      const item = JSON.parse(await readFile(target, "utf8"));
      if (item.profileId !== current.profileId) continue;
      if (current.enabled && item.epoch === current.epoch) await request(info, route, item, AbortSignal.timeout(2500));
      await unlink(target);
    }
  }
  function flush() {
    flushing ??= drain().catch(() => {}).finally(() => { flushing = undefined; });
    return flushing;
  }
  return {
    async begin() {
      const current = await currentConsent().catch(() => undefined);
      if (current?.enabled) return { profileId: current.profileId, epoch: current.epoch };
    },
    async complete(owner, recording) {
      if (!owner || recording.stoppedAt <= recording.startedAt) return;
      const current = await currentConsent().catch(() => undefined);
      if (current && (!current.enabled || current.epoch !== owner.epoch || current.profileId !== owner.profileId)) return;
      const target = join(directory, owner.profileId + "." + recording.id + ".json");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = target + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify({ ...owner, ...recording }), { mode: 0o600 });
      await rename(temp, target);
      await flush();
    },
    flush,
  };
}
