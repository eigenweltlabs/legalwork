import { createHash } from "node:crypto";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { browserPasswords } from "./browser-passwords.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { readInstalledCloudPlugins, resolveWorkspaceInstallPath } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID } from "./runtime-opencode-config-store.js";
import { openSqlite, runtimeDbPath } from "./runtime-db.js";
import { researchExperienceAction, researchExperienceEntry, researchExperienceInstruction } from "./research-experience-schema.js";
import type { ServerConfig } from "./types.js";

type Package = { name: string; directory: string; hash: string; scope: string };

/** Match the installed owner's exact package, never a project skill with the same name. */
export async function researchExperienceOwner(config: ServerConfig, workspace: string, skill: Package) {
  if (skill.scope !== "global") return undefined;
  const installed = await readInstalledCloudPlugins(config, GLOBAL_MCP_ID);
  for (const plugin of Object.values(installed.plugins)) {
    if (!/^local:legal-research-[a-z0-9-]+:global$/.test(plugin.pluginId)) continue;
    for (const file of plugin.files) if (file.objectType === "skill" && file.title === skill.name
      && await canonicalFilePath(resolveWorkspaceInstallPath(workspace, file.path, true)) === resolve(skill.directory, "SKILL.md")) return plugin.pluginId;
  }
}

/** The built-in skill owns per-website notes without installing a site skill. */
export async function researchWebsiteExperienceOwner(config: ServerConfig, workspace: string, skill: Package, connectionId: string, websiteUrl: string) {
  const source = CORE_OPENCODE_FILES.find(file => file.path === ".opencode/skills/legal-research/SKILL.md");
  if (!source || skill.name !== "legal-research" || await canonicalFilePath(resolve(workspace, source.path)) !== resolve(skill.directory, "SKILL.md")
    || await readFile(resolve(skill.directory, "SKILL.md"), "utf8") !== source.content) return undefined;
  const connection = (await browserPasswords(config).list()).find(item => item.id === connectionId);
  if (!connection?.websites.some(site => site.url === websiteUrl)) throw new ApiError(404, "website_connection_not_found", "Choose an existing saved website destination.");
  return `website:${connectionId}:${createHash("sha256").update(websiteUrl).digest("hex")}`;
}

/** Operational notes stay outside import-owned files, so setup and plugin updates preserve them. */
export async function researchExperience(config: ServerConfig, pluginId: string, skill: Package, raw: unknown = { action: "read" }) {
  const parsed = researchExperienceAction.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "research_experience_invalid", "Use a bounded operational note, its key and the latest revision.");
  const action = parsed.data;
  if (action.action === "save") {
    const prose = [action.note.key, action.note.situation, action.note.attempt, action.note.outcome].join("\n");
    // Defense in depth, not a promise to detect every secret in free text. The
    // tool only accepts generic observations and never retrieves vault values.
    if (/https?:|www\.|\b[^\s@]+@[^\s@]+\.[^\s@]+|\b(?:password|username|cookie|token|authorization|secret|session[_-]?id)\s*[:=]|\b[A-Za-z0-9_+/=-]{48,}\b|<\/?[a-z][^>]*>/i.test(prose)) {
      throw new ApiError(400, "research_experience_private", "Remove URLs, account details, credential values and raw page content. Save only a generic description of the problem, attempt and observed outcome.");
    }
  }
  const path = runtimeDbPath(config);
  await mkdir(dirname(path), { recursive: true });
  const db = await openSqlite(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS research_skill_experience (plugin_id TEXT NOT NULL, issue_key TEXT NOT NULL, note_json TEXT NOT NULL, PRIMARY KEY (plugin_id, issue_key))");
    const read = () => db.all("SELECT note_json FROM research_skill_experience WHERE plugin_id = ? ORDER BY issue_key", [pluginId])
      .map(row => researchExperienceEntry.parse(JSON.parse(z.string().parse(row.note_json))));
    if (action.action !== "read") {
      // One transaction prevents concurrent chats losing each other's lessons.
      db.exec("BEGIN IMMEDIATE");
      try {
        const entries = read(), key = action.action === "save" ? action.note.key : action.key;
        const existing = entries.find(entry => entry.key === key);
        const unchanged = action.action === "save" && existing && existing.skillHash === skill.hash
          && ["status", "situation", "attempt", "outcome"].every(field => Reflect.get(existing, field) === Reflect.get(action.note, field));
        if (unchanged && existing.revision !== action.expectedRevision) {
          // An identical retry after a lost response is already committed.
        } else {
          if ((existing?.revision ?? 0) !== action.expectedRevision) throw new ApiError(409, "research_experience_changed", "This note changed in another chat. Read the latest notes before updating it.");
          if (action.action === "forget") {
            db.run("DELETE FROM research_skill_experience WHERE plugin_id = ? AND issue_key = ?", [pluginId, key]);
          } else {
            if (!existing && entries.length >= 30) throw new ApiError(409, "research_experience_full", "This skill has 30 notes. Consolidate or forget an obsolete note before adding another.");
            const entry = { ...action.note, revision: (existing?.revision ?? 0) + 1, observedAt: new Date().toISOString(), skillHash: skill.hash };
            db.run("INSERT INTO research_skill_experience (plugin_id, issue_key, note_json) VALUES (?, ?, ?) ON CONFLICT(plugin_id, issue_key) DO UPDATE SET note_json = excluded.note_json", [pluginId, key, JSON.stringify(entry)]);
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    return { name: skill.name, tool: "legalwork_research_experience", instruction: researchExperienceInstruction,
      entries: read().map(entry => ({ ...entry, needsRecheck: entry.skillHash !== skill.hash || Date.now() - Date.parse(entry.observedAt) > 30 * 86400_000 })) };
  } finally { db.close(); }
}

export async function withResearchExperience<T extends Package>(config: ServerConfig, workspace: string, skill: T) {
  const owner = await researchExperienceOwner(config, workspace, skill);
  return owner ? { ...skill, researchExperience: await researchExperience(config, owner, skill) } : skill;
}
