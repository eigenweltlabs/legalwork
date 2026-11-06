import type { WikiViewSnapshots } from "@legalwork/types/views";
import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { HTMLPreview } from "../session/artifacts/preview";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { ViewHostProvider } from "../views/view-host";
import { WikiPreview } from "./wiki-preview";
import { resolveWikiLink, wikiMarkdownBody } from "./wiki-model";
import { wikiPanelTab } from "./wiki-tabs";

/** Render review content without granting it writes or external network access. */
export function WikiContentPreview({ client, wikiId, path, content, historicalViews, stagedFiles }: { client: LegalworkServerClient; wikiId: string; path: string; content: string; historicalViews?: { id: string; snapshots: WikiViewSnapshots }; stagedFiles?: { paths: string[]; open: (path: string) => void } }) {
  const request = useRequestPanelTab();
  const snapshot = useQuery({ queryKey: ["wiki-snapshot", client.baseUrl, wikiId], queryFn: () => client.wikiSnapshot(wikiId) });
  const pages = snapshot.data?.pages ?? [];
  const files = [...(snapshot.data?.assets.map(asset => asset.path) ?? []), ...(stagedFiles?.paths ?? [])];
  const urls = useRef(new Set<string>());
  useEffect(() => { const active = urls.current; return () => { active.forEach(URL.revokeObjectURL); active.clear(); }; }, [client.baseUrl, wikiId, content]);
  const imagePreview = useCallback(async (source: string) => {
    const target = resolveWikiLink(snapshot.data?.pages ?? [], snapshot.data?.assets.map(asset => asset.path) ?? [], source, path, false);
    if (!target || target.kind !== "asset") throw new Error(t("wiki.invalid_image"));
    const result = await client.downloadWikiAsset(wikiId, target.path);
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(result.contentType ?? "")) throw new Error(t("wiki.invalid_image"));
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    urls.current.add(url); return url;
  }, [client, wikiId, path, snapshot.data]);
  const open = (target: string, anchor?: string) => request(wikiPanelTab(client.baseUrl, wikiId, { kind: "page", path: target, anchor }, target));
  const body = wikiMarkdownBody(content).trim();
  const html = /^<!doctype html\b|^<html\b/i.test(body) ? body : /^```html\s*\n([\s\S]*?)\n```$/i.exec(body)?.[1];
  if (html || /\.html?$/i.test(path)) return <div className="h-[55vh]"><HTMLPreview type="text" title={path} content={html ?? content} /></div>;
  return <ViewHostProvider client={client} owner={{ kind: "wiki", id: wikiId }} readOnly historicalViews={historicalViews} openSource={open}><WikiPreview content={content} path={path} pages={pages} files={files} onOpen={open} onMissing={() => toast.error(t("wiki.missing_link"))} onAsset={target => stagedFiles?.paths.includes(target) ? stagedFiles.open(target) : request(wikiPanelTab(client.baseUrl, wikiId, { kind: "asset", path: target }, target))} imagePreview={imagePreview} /></ViewHostProvider>;
}
