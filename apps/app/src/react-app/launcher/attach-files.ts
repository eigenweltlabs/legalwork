import type { AssistantContextItem } from "@legalwork/types/launcher";
import type { DraftCoordinator } from "./draft-coordinator";
import { persistentContext } from "./launcher-context-lifecycle";

/** Keep uploads attached to the conversation that accepted the drop, even across a handoff. */
export async function attachFilesToDraft(options: {
  files: File[]; conversationId: string; owner: string; drafts: DraftCoordinator;
  stage: (file: File) => Promise<AssistantContextItem>;
  context?: () => AssistantContextItem[];
  onAttached?: (context: AssistantContextItem[]) => void;
}) {
  const { files, conversationId, owner, drafts, stage } = options;
  await drafts.flush();
  await drafts.reconcile();
  if (!drafts.owns(conversationId, owner)) throw new Error("Focus this conversation before attaching files.");
  return drafts.protect(conversationId, owner, async () => {
    const failures: { name: string; error: string }[] = [];
    let added = 0;
    for (const file of files) {
      try {
        if ((options.context?.() ?? drafts.get(conversationId).context).length >= 50) throw new Error("Maximum 50 attachments per message.");
        if (file.size > 64 * 1024 * 1024) throw new Error("Maximum file size is 64 MiB.");
        const item = await stage(file);
        const context = options.context?.() ?? drafts.get(conversationId).context;
        if (context.length >= 50) throw new Error("Maximum 50 attachments per message.");
        const next = [...context, item];
        await drafts.update(conversationId, owner, { context: persistentContext(next) });
        options.onAttached?.(next);
        added++;
      } catch (error) { failures.push({ name: file.name, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { added, failures };
  });
}

/** Directories are not uploads. Search roots are configured explicitly in Settings. */
export function droppedFiles(transfer: DataTransfer) {
  const items = Array.from(transfer.items).filter(item => item.kind === "file");
  return { folders: items.some(item => item.webkitGetAsEntry?.()?.isDirectory),
    files: items.length ? items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory).flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; }) : Array.from(transfer.files) };
}
