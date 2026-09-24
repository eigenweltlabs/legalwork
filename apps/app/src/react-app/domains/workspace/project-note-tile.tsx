import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, StickyNote } from "lucide-react";
import { marked } from "marked";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { noteTitle } from "./project-note-title";

/** Plain text only: links and images in a preview must not take over the tile. */
function notePreview(markdown: string, title: string) {
  const tokens = marked.lexer(markdown.slice(0, 16000).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
  const first = tokens[0];
  if (first?.type === "heading" && first.depth === 1 && first.text.trim().toLowerCase() === title.toLowerCase()) tokens.shift();
  const text: string[] = [];
  marked.walkTokens(tokens, (token) => {
    if ((token.type === "text" && !token.tokens) || token.type === "codespan" || token.type === "code" || token.type === "image") text.push(token.text);
  });
  return text.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

export function ProjectNoteTile({ client, workspaceId, entry, onOpen }: {
  client: LegalworkServerClient;
  workspaceId: string;
  entry: LegalworkWorkspaceDirectoryEntry;
  onOpen: () => void;
}) {
  const title = noteTitle(entry.name);
  // Share the editor's cache so a saved edit appears in the tile immediately.
  // Only mounted tiles read their files, so each page loads at most six notes.
  const preview = useQuery({
    queryKey: ["markdown-editor", workspaceId, entry.path],
    queryFn: () => client.readWorkspaceFile(workspaceId, entry.path),
    select: (data) => notePreview(data.content, title),
  });
  return (
    <Button variant="outline" className="group/note h-full min-h-40 w-full flex-col items-start justify-start gap-3 whitespace-normal rounded-xl border-border/70 bg-muted/15 p-4 text-left font-normal shadow-none hover:bg-muted/40" aria-label={title} onClick={onOpen}>
      <span className="flex w-full items-center justify-between text-muted-foreground">
        <StickyNote className="size-4" />
        <ArrowUpRight className="size-3.5 opacity-0 group-hover/note:opacity-100 group-focus-visible/note:opacity-100" />
      </span>
      <span className="line-clamp-2 w-full break-words text-sm font-medium leading-5">{title}</span>
      {preview.isPending ? <Skeleton className="h-8 w-full" /> : <span className="line-clamp-3 w-full break-words text-xs leading-5 text-muted-foreground">{preview.isError ? t("projects.note_preview_failed") : preview.data || t("projects.note_empty")}</span>}
    </Button>
  );
}
