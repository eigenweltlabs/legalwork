import { useEffect, useRef, useState } from "react";
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
  // The Markdown editor emits entities such as &#x20; and &amp;. Decode them
  // as text, escaping literal markup so a preview never creates HTML nodes.
  const decoded = document.createElement("textarea");
  decoded.innerHTML = text.join(" ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return decoded.value.replace(/\s+/g, " ").trim().slice(0, 280);
}

export function ProjectNoteTile({ client, workspaceId, entry, onOpen }: {
  client: LegalworkServerClient;
  workspaceId: string;
  entry: LegalworkWorkspaceDirectoryEntry;
  onOpen: () => void;
}) {
  const title = noteTitle(entry.name);
  const tileRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(tile);
    return () => observer.disconnect();
  }, []);
  // Share the editor's cache so a saved edit appears in the tile immediately.
  // Read previews as notes scroll into view.
  const preview = useQuery({
    queryKey: ["markdown-editor", workspaceId, entry.path],
    queryFn: () => client.readWorkspaceFile(workspaceId, entry.path),
    select: (data) => notePreview(data.content, title),
    enabled: visible,
  });
  return (
    <Button ref={tileRef} variant="outline" className="group/note h-32 w-full flex-col items-start justify-start gap-2 whitespace-normal rounded-xl border-border/70 bg-muted/15 p-3 text-left font-normal shadow-none hover:bg-muted/40" aria-label={title} title={title} onClick={onOpen}>
      <span className="flex w-full items-center justify-between text-muted-foreground">
        <StickyNote className="size-3.5" />
        <ArrowUpRight className="size-3.5 opacity-0 group-hover/note:opacity-100 group-focus-visible/note:opacity-100" />
      </span>
      <span className="w-full truncate text-sm font-medium leading-5">{title}</span>
      {preview.isPending ? <Skeleton className="h-8 w-full" /> : <span className="line-clamp-2 w-full break-words text-xs leading-5 text-muted-foreground">{preview.isError ? t("projects.note_preview_failed") : preview.data || t("projects.note_empty")}</span>}
    </Button>
  );
}
