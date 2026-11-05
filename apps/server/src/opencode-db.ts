import { createHash, randomUUID } from "node:crypto";
import type { OpenCodeClient, JsonValue, SessionInfo } from "@opencode/client";
import { findApiError } from "./errors.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";



type SeedMessage = {
  role: "assistant" | "user";
  text: string;
};

const DEFAULT_AGENT = "legalwork";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.4";
const LEGALWORK_DEV_DATA_DIRS = ["legalwork-dev-data", "opencode-dev"];

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function opencodeOrchestratorDataDirs(): string[] {
  const root = process.env.LEGALWORK_DATA_DIR?.trim();
  if (!root) return [];

  const dirs: string[] = [];
  const pushIfExists = (dir: string) => {
    if (existsSync(dir)) dirs.push(dir);
  };

  for (const name of LEGALWORK_DEV_DATA_DIRS) {
    const base = join(root, name);
    pushIfExists(join(base, "xdg", "data", "opencode"));
    if (!existsSync(base)) continue;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      pushIfExists(join(base, entry.name, "xdg", "data", "opencode"));
    }
  }

  return dirs;
}

function opencodeDataDirs(): string[] {
  const dirs: string[] = [];
  dirs.push(...opencodeOrchestratorDataDirs());
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) dirs.push(join(xdg, "opencode"));
  dirs.push(join(homedir(), ".local", "share", "opencode"));
  if (process.platform === "darwin") dirs.push(join(homedir(), "Library", "Application Support", "opencode"));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) dirs.push(join(appData, "opencode"));
  }
  return Array.from(new Set(dirs));
}

function preferredDbNames(): string[] {
  const channel = process.env.OPENCODE_CHANNEL?.trim() || "local";
  return channel === "latest" || channel === "beta" || truthy(process.env.OPENCODE_DISABLE_CHANNEL_DB)
    ? ["opencode.db"]
    : [`opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`, "opencode.db"];
}

function candidateOpencodeDbPaths(): string[] {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) {
    if (isAbsolute(override)) return [override];
    const candidates: string[] = [];
    for (const dir of opencodeDataDirs()) {
      candidates.push(join(dir, override));
    }
    candidates.push(join(opencodeDataDirs()[0] ?? join(homedir(), ".local", "share", "opencode"), override));
    return Array.from(new Set(candidates));
  }

  const candidates: string[] = [];
  for (const dir of opencodeDataDirs()) {
    for (const name of preferredDbNames()) {
      candidates.push(join(dir, name));
    }
  }

  return Array.from(new Set(candidates));
}

export function resolveOpencodeDbPath(): string {
  const candidates = candidateOpencodeDbPaths();
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;
  return candidates[0] ?? join(homedir(), ".local", "share", "opencode", preferredDbNames()[0] ?? "opencode.db");
}

/** First existing OpenCode DB on this machine, or null when none exists yet. */
export function findExistingOpencodeDbPath(): string | null {
  return candidateOpencodeDbPaths().find((candidate) => existsSync(candidate)) ?? null;
}

/** Create template history atomically through the native import API. V2
 * rejects an existing ID, so a retried template import cannot overwrite a chat. */
export async function createSeededOpencodeSession(input: {
  client: OpenCodeClient; workspaceRoot: string; workspaceId: string;
  templateId: string; title: string; messages: SeedMessage[]; now?: number;
}): Promise<SessionInfo> {
  const id = `ses_blueprint_${createHash("sha256").update(`${input.workspaceId}\0${input.templateId}`).digest("hex")}`;
  const existing = await input.client.session.get({ sessionID: id }).catch(error => {
    if (findApiError(error)?.status === 404) return null;
    throw error;
  });
  if (existing) {
    if (existing.location.directory !== input.workspaceRoot || existing.metadata?.legalworkBlueprintTemplate !== input.templateId)
      throw new Error("The template chat identity belongs to another project or template.");
    return existing;
  }
  const now = input.now ?? Date.now();
  const location = { directory: input.workspaceRoot };
  const project = (await input.client.location.get({ location })).project;
  const messages = input.messages.filter(message => message.text.trim()).map((message, index): JsonValue => {
    const created = now + index, id = `msg_${randomUUID().replaceAll("-", "")}`;
    const metadata = { legalworkBlueprintSeed: true };
    if (message.role === "user") return { type: "user", id, text: message.text, time: { created }, metadata };
    return { type: "assistant", id, agent: DEFAULT_AGENT, model: { providerID: DEFAULT_PROVIDER, id: DEFAULT_MODEL },
      content: [{ type: "text", text: message.text }], finish: "stop", time: { created, completed: created }, metadata };
  });
  return input.client.session.import({ location,
    info: { id, projectID: project.id, location, title: input.title, agent: DEFAULT_AGENT,
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now + messages.length }, metadata: { legalworkBlueprintTemplate: input.templateId } }, messages,
  }).catch(async error => {
    // A second window may have imported the same template after our lookup.
    // Only accept that race when the immutable project/template identity agrees.
    if (findApiError(error)?.status !== 409) throw error;
    const winner = await input.client.session.get({ sessionID: id });
    if (winner.location.directory !== input.workspaceRoot || winner.metadata?.legalworkBlueprintTemplate !== input.templateId) throw error;
    return winner;
  });
}
