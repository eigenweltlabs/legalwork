import type { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalFilePath } from "../file-write-lock.js";
import { permissionPatternMatches } from "../agent-sandbox/permissions.js";
import { projectPermissionEffect } from "../project-permission-approvals.js";
import type { ManagedEngineSettings } from "../managed-engine-settings.js";

const strictness = { allow: 0, ask: 1, deny: 2 };
const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};
const home = (path: string) => path === "~" || path === "$HOME" ? homedir()
  : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path.startsWith("$HOME/") ? join(homedir(), path.slice(6)) : path;

/** Folder grants belong to LegalWork projects, not the engine's possibly wider
 * Git project. Evaluation runs for late-loaded helpers too. Native agent/firm
 * denials remain authoritative; remembered approvals enter these same settings. */
export async function registerManagedFolderPermissions(ctx: Plugin.Context, read: () => Promise<ManagedEngineSettings | undefined>) {
  return ctx.permission.hook("evaluate", async event => {
    if (event.effect === "deny") return;
    const settings = await read();
    if (!settings) { event.effect = "deny"; event.message = "This project has no LegalWork permissions."; return; }
    const session = await ctx.session.get({ sessionID: event.sessionID });
    const agentID = event.agent ?? session.agent ?? settings.configuration.default_agent;
    const approvals = [...settings.projectPermissionApprovals ?? [], ...session.permissions?.filter(rule => rule.effect === "allow")
      .map(rule => ({ action: rule.action, resources: [rule.resource] })) ?? []];
    event.effect = projectPermissionEffect({ ...settings.configuration, projectPermissionApprovals: approvals }, event.action,
      event.resources, event.metadata?.legalworkCanonicalAsk ? "ask" : event.effect, agentID);
    if (event.effect === "deny") return;
    if (!["external_directory", "read", "edit", "glob", "grep", "list"].includes(event.action)) return;
    if (event.action === "external_directory") {
      if (!event.metadata?.legalworkCanonicalResources) {
        const canonical = await Promise.all(event.resources.map(async resource => {
          if (!resource.replaceAll("\\", "/").endsWith("/*")) return resource;
          const folder = dirname(home(resource));
          return join(await canonicalFilePath(folder), "*").replaceAll("\\", "/");
        }));
        const resources = [...new Set([...event.resources, ...canonical])];
        if (resources.length !== event.resources.length) {
          await ctx.permission.assert({ action: event.action, resources, save: resources, sessionID: event.sessionID,
            ...(event.agent ? { agent: event.agent } : {}), ...(event.source ? { source: event.source } : {}),
            metadata: { ...event.metadata, legalworkCanonicalResources: true, legalworkCanonicalAsk: event.effect === "ask" } });
          event.effect = "allow";
          return;
        }
      }
      let required: "allow" | "ask" | "deny" = "allow";
      for (const resource of event.resources) {
        if (resource.replaceAll("\\", "/").endsWith("/*")) {
          const folder = dirname(home(resource));
          const actual = await canonicalFilePath(folder);
          if (actual !== folder) event.message = `This folder resolves to ${actual}. Remembering approval includes that destination.`;
        }
        let effect: "allow" | "ask" | "deny" = "ask";
        for (const rule of settings.configuration.permissions ?? []) {
          // A general tool allow does not grant another filesystem folder.
          if (rule.action === "external_directory" && permissionPatternMatches(resource, home(rule.resource))) effect = rule.effect;
        }
        if (effect !== "deny" && approvals.some(approval => permissionPatternMatches("external_directory", approval.action)
          && approval.resources.some(pattern => permissionPatternMatches(resource, home(pattern))))) effect = "allow";
        if (strictness[effect] > strictness[required]) required = effect;
      }
      if (strictness[required] > strictness[event.effect]) event.effect = required;
      return;
    }
    const directory = ctx.location.directory;
    const root = await canonicalFilePath(settings.directory);
    // Native reads/edits use relative resources inside a Git worktree, even
    // when the target is outside this LegalWork project. Check that gap too.
    const paths = event.action === "read" || event.action === "edit"
      ? event.resources.map(path => resolve(directory, home(path)))
      : typeof event.metadata?.path === "string" ? [resolve(directory, home(event.metadata.path))]
      : typeof event.metadata?.root === "string" ? [resolve(directory, home(event.metadata.root))] : [];
    const targets = await Promise.all(paths.map(async path => ({ path, actual: await canonicalFilePath(path) })));
    if (["read", "edit"].includes(event.action) && !event.metadata?.legalworkCanonicalResources && targets.some(({ path, actual }) => path !== actual)) {
      const resources = [...new Set([...event.resources, ...targets.map(({ actual }) => actual)])];
      // Evaluate both names in one request, preserving canonical denials and
      // avoiding two sensitive-file prompts for the same symlink operation.
      await ctx.permission.assert({ action: event.action, resources, save: resources,
        sessionID: event.sessionID, ...(event.agent ? { agent: event.agent } : {}), ...(event.source ? { source: event.source } : {}),
        metadata: { ...event.metadata, legalworkCanonicalResources: true, legalworkCanonicalAsk: event.effect === "ask" } });
      event.effect = "allow";
      return;
    }
    for (const { path, actual } of targets) {
      // This tool verifies chat ownership and a regular output file before
      // reading. Retain lexical and canonical read rules without asking users
      // to add the app's private saved-output directory to their project.
      if (event.action === "read" && event.metadata?.legalworkVerifiedToolOutput === true) continue;
      if (within(root, actual)) continue;
      // Absolute read/edit resources already crossed the native boundary;
      // a changed canonical target is a symlink escape and needs its own check.
      if (["read", "edit"].includes(event.action) && event.resources.some(resource => isAbsolute(resource) && resolve(home(resource)) === path) && actual === path && !event.metadata?.browserUpload) continue;
      // External absolute searches already obtained native folder approval.
      const projectRoot = resolve(ctx.location.project.directory);
      if (!["read", "edit"].includes(event.action) && !within(projectRoot, path) && actual === path) continue;
      const directoryTarget = await stat(actual).then(info => info.isDirectory(), error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      });
      const folder = directoryTarget ? actual : dirname(actual);
      const resource = join(folder, "*").replaceAll("\\", "/");
      await ctx.permission.assert({ action: "external_directory", resources: [resource], save: [resource],
        sessionID: event.sessionID, ...(event.agent ? { agent: event.agent } : {}), ...(event.source ? { source: event.source } : {}),
        metadata: { path: folder, legalworkFolderApproval: true } });
    }
  });
}
