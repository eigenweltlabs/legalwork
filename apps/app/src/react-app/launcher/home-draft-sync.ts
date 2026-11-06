import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useLocal } from "@/react-app/kernel/local-provider";
import { stageFiles } from "./context-capture";
import { useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import { createProjectAttachmentMention, createWorkspaceAttachmentMention } from "@/react-app/domains/session/surface/composer/workspace-attachment";
import type { LauncherDraft } from "@legalwork/types/launcher";
import { sharedDraftCoordinator, windowOwnerId } from "./launcher-route";

/** The panel's complete draft as Home composer text: file references become attachment mentions, captured text is quoted. */
export function launcherDraftToComposerText(draft: Pick<LauncherDraft, "text" | "context">, assistantWorkspaceId: string, projectNames: Map<string, string>) {
  const parts = [draft.text.trim()];
  for (const item of draft.context) {
    if (item.type === "file" && item.path) parts.push(item.workspaceId && item.workspaceId !== assistantWorkspaceId ? createProjectAttachmentMention({ projectId: item.workspaceId, workspaceId: item.workspaceId, path: item.path, name: item.name }, projectNames.get(item.workspaceId) ?? item.sourceLabel ?? item.workspaceId) : createWorkspaceAttachmentMention(item.name, item.path));
    else if (item.type === "image" && item.path) parts.push(item.workspaceId && item.workspaceId !== assistantWorkspaceId ? createProjectAttachmentMention({ projectId: item.workspaceId, workspaceId: item.workspaceId, path: item.path, name: item.name }, projectNames.get(item.workspaceId) ?? item.workspaceId) : createWorkspaceAttachmentMention(item.name, item.path));
    else if (item.type === "selection") parts.push(`${item.sourceApp ? `${item.sourceApp}${item.sourceWindow ? ` (${item.sourceWindow})` : ""}:\n` : ""}"""\n${item.text}\n"""`);
    else if (item.type === "clipboard") parts.push(`"""\n${item.text}\n"""`);
  }
  return parts.filter(Boolean).join("\n\n");
}

const pendingWrites = new Map<string, Promise<void>>();
export async function flushHomeDraft(conversationId: string) {
  await pendingWrites.get(conversationId);
  await sharedDraftCoordinator().flush();
}

/** Home persists text, mention/paste identities and uploaded attachment references
 * into the same draft as the panel. Uploads finish before ownership can move. */
export function useHomeDraftSync(input: { projectTarget?: string | null; active: boolean; conversationId: string | null; sessionId: string | null; assistantWorkspaceId: string | null; projectNames: Map<string, string>; client: LegalworkServerClient | null }) {
  const owner = useRef(windowOwnerId("home"));
  const drafts = sharedDraftCoordinator();
  const local = useLocal();
  const latest = useRef(local);
  latest.current = local;
  useEffect(() => {
    const { active, conversationId, sessionId, assistantWorkspaceId, client } = input;
    if (!active || !conversationId || !sessionId || !assistantWorkspaceId || !client) return;
    let disposed = false, applying = false;
    let presentedContext: LauncherDraft["context"] = [];
    let writes: Promise<void> = Promise.resolve();
    const uploads = new Map<string, LauncherDraft["context"][number]>();
    const show = () => {
      if (disposed) return;
      const draft = drafts.get(conversationId);
      presentedContext = draft.context;
      const composer = useComposerStateStore.getState();
      applying = true;
      composer.setDraft(sessionId, launcherDraftToComposerText(draft, assistantWorkspaceId, input.projectNames));
      composer.setMentions(sessionId, draft.composer?.mentions ?? {});
      composer.setPasteParts(sessionId, draft.composer?.pasteParts ?? []);
      composer.setAttachments(sessionId, []);
      applying = false;
      if (draft.model) latest.current.setPrefs(previous => ({ ...previous, defaultModel: draft.model, modelVariant: draft.variant }));
    };
    const claim = async (take = true) => {
      await drafts.ready();
      await writes;
      if (take || !drafts.lease(conversationId) || drafts.isLeaseStale(conversationId)) await drafts.claim(conversationId, owner.current);
      // An existing project composer can predate its launcher registration.
      // Seed it once, before showing the shared draft, including pending files.
      const existing = useComposerStateStore.getState().sessions[sessionId];
      if (drafts.owns(conversationId, owner.current) && drafts.get(conversationId).revision === 0 && existing && (existing.draft || existing.attachments.length)) {
        await drafts.protect(conversationId, owner.current, async () => {
          const context: LauncherDraft["context"] = [];
          for (const attachment of existing.attachments) context.push(...await stageFiles(client, assistantWorkspaceId, [attachment.file]));
          const current = useComposerStateStore.getState().sessions[sessionId] ?? existing;
          await drafts.update(conversationId, owner.current, { text: current.draft, context, composer: { mentions: current.mentions, pasteParts: current.pasteParts }, target: input.projectTarget ? { kind: "project", workspaceId: input.projectTarget } : { kind: "assistant" } });
        });
      }
      show();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[data-lw-composer], .lw-composer, [contenteditable="true"]') && !drafts.owns(conversationId, owner.current)) void claim().catch(error => toast.error(String(error)));
    };
    document.addEventListener("focusin", onFocus);
    void claim(false).catch(error => toast.error(String(error)));
    const unsubscribe = useComposerStateStore.subscribe((state, previous) => {
      const current = state.sessions[sessionId];
      if (applying || !current || current === previous.sessions[sessionId] || !drafts.owns(conversationId, owner.current)) return;
      writes = writes.catch(() => {}).then(() => drafts.protect(conversationId, owner.current, async () => {
        for (const attachment of current.attachments) if (!uploads.has(attachment.id)) {
          const [item] = await stageFiles(client, assistantWorkspaceId, [attachment.file]);
          if (item) uploads.set(attachment.id, { ...item, id: `home_${attachment.id}` });
        }
        const rendered = launcherDraftToComposerText({ text: "", context: presentedContext }, assistantWorkspaceId, input.projectNames);
        const keepsContext = Boolean(rendered && current.draft.trimEnd().endsWith(rendered));
        const context = keepsContext ? [...presentedContext] : [];
        for (const attachment of current.attachments) { const item = uploads.get(attachment.id); if (item) context.push(item); }
        await drafts.update(conversationId, owner.current, {
          text: keepsContext ? current.draft.trimEnd().slice(0, -rendered.length).trim() : current.draft,
          context, composer: { mentions: current.mentions, pasteParts: current.pasteParts },
          model: latest.current.prefs.defaultModel, variant: latest.current.prefs.modelVariant,
        });
      }));
      pendingWrites.set(conversationId, writes);
      void writes.catch(error => toast.error(String(error)));
    });
    const unsubscribeDrafts = drafts.subscribe(id => { if (id === conversationId && !drafts.owns(id, owner.current)) show(); });
    return () => { disposed = true; document.removeEventListener("focusin", onFocus); unsubscribe(); unsubscribeDrafts(); };
  }, [input.active, input.conversationId, input.sessionId, input.assistantWorkspaceId, input.client]);
}
