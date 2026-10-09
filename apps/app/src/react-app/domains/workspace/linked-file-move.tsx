import { useState } from "react";
import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { ProjectFileLink, ProjectFileSource } from "@legalwork/types/project-files";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { usePanelTabStore } from "../session/panel/panel-tab-store";

export type LinkProject = { client: LegalworkServerClient; workspaceId: string; projectId: string; name: string };
type Prompt = { id: string; names: string; resolve?: (accepted: boolean) => void; repair?: () => Promise<void> };
const prompts = create<{ items: Prompt[] }>(() => ({ items: [] }));
const add = (prompt: Omit<Prompt, "id">) => prompts.setState(state => ({ items: [...state.items, { ...prompt, id: crypto.randomUUID() }] }));
export const linkedFileMovePrompts = prompts;
const confirm = (names: string) => new Promise<boolean>(resolve => add({ names, resolve }));

/** Read through each project's own endpoint; never assume local and remote IDs
 * identify the same source. A failed lookup prevents a misleading all-clear. */
export async function prepareLinkedFileMove(projects: LinkProject[], file: { client: LegalworkServerClient; workspaceId: string }, from: string, to: string, queries: QueryClient, decide = confirm) {
  const source = projects.find(project => project.client.baseUrl === file.client.baseUrl && project.client.token === file.client.token && project.workspaceId === file.workspaceId);
  if (!source) return async () => {};
  const matchesSource = (link: ProjectFileSource) => link.projectId === source.projectId && link.workspaceId === source.workspaceId && !link.connectionId && (link.path === from || link.path.startsWith(`${from}/`));
  const matches = (link: ProjectFileLink) => matchesSource(link.source);
  const affected: Array<{ project: LinkProject; ids: string[] }> = [];
  for (const project of projects) {
    const { links } = await project.client.projectFileLinks(project.workspaceId);
    const ids = links.filter(matches).map(link => link.id);
    if (ids.length) affected.push({ project, ids });
  }
  if (!affected.length) return async () => {};
  const names = affected.map(({ project }) => project.name).join(", ");
  if (!await decide(names)) return null;
  const repair = async () => {
    const failed: string[] = [];
    for (const { project, ids } of affected) {
      try {
        // Preserve concurrent link renames/removals and deliberate retargeting.
        const { links } = await project.client.projectFileLinks(project.workspaceId);
        for (const link of links.filter(link => ids.includes(link.id) && matches(link))) {
          await project.client.updateProjectFileLink(project.workspaceId, { ...link, source: { ...link.source, path: `${to}${link.source.path.slice(from.length)}` } });
        }
        await queries.invalidateQueries({ queryKey: ["project-file-links", project.client.baseUrl, project.workspaceId] });
      } catch (error) { failed.push(`${project.name}: ${error instanceof Error ? error.message : t("storage.failed")}`); }
    }
    if (failed.length) throw new Error(failed.join("\n"));
  };
  return async () => {
    // Open linked readers follow the same original even if metadata repair is
    // temporarily offline. The original's ownership lock excludes dirty writers.
    usePanelTabStore.setState(state => {
      const sessions = { ...state.sessions };
      for (const [scope, session] of Object.entries(sessions)) {
        let changed = false;
        const tabs = session.tabs.map(tab => {
          if (tab.type !== "artifact" || !tab.sourceProject || !matchesSource(tab.sourceProject)) return tab;
          changed = true;
          const path = `${to}${tab.sourceProject.path.slice(from.length)}`;
          return { ...tab, value: path, sourceProject: { ...tab.sourceProject, path } };
        });
        if (changed) sessions[scope] = { ...session, tabs };
      }
      return { sessions };
    });
    try { await repair(); }
    catch { add({ names, repair }); }
  };
}

export function LinkedFileMoveDialogs() {
  const prompt = prompts(state => state.items[0]);
  return prompt ? <LinkedFileMoveDialog key={prompt.id} prompt={prompt} /> : null;
}
function LinkedFileMoveDialog({ prompt }: { prompt: Prompt }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = (accepted: boolean) => {
    prompts.setState(state => ({ items: state.items.filter(item => item.id !== prompt.id) }));
    prompt.resolve?.(accepted);
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(false); }}><DialogContent>
    <DialogHeader><DialogTitle>{t(prompt.repair ? "project_files.relink_failed" : "project_files.move_linked_title")}</DialogTitle>
      <DialogDescription>{t(prompt.repair ? "project_files.relink_retry_hint" : "project_files.move_linked_hint", { projects: prompt.names })}</DialogDescription></DialogHeader>
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => close(false)}>{t(prompt.repair ? "common.close" : "common.cancel")}</Button>
      <Button disabled={busy} onClick={() => {
        if (!prompt.repair) { close(true); return; }
        setBusy(true); setError("");
        void prompt.repair().then(() => close(true)).catch(error => setError(error instanceof Error ? error.message : t("storage.failed"))).finally(() => setBusy(false));
      }}>{t(prompt.repair ? "workspace_files.try_again" : "project_files.move_and_relink")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
