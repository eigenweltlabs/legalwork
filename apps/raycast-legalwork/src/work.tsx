import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { launch, readPairing, requirePairing, request, type Pairing, type WorkItem } from "./legalwork";

const ICONS: Record<string, Icon> = { "input-required": Icon.QuestionMark, running: Icon.CircleProgress, queued: Icon.Clock, returned: Icon.CheckCircle, failed: Icon.XMarkCircle, stopped: Icon.Stop, unavailable: Icon.Warning };

export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void readPairing().then(async found => {
      if (controller.signal.aborted) return;
      setPairing(found);
      if (!found) { setItems([]); return; }
      const work: WorkItem[] = []; let offset: number | null = 0;
      do {
        const page: { items: WorkItem[]; nextOffset: number | null } = await request(found, `/assistant/work?limit=100&offset=${offset}`, { signal: controller.signal });
        work.push(...page.items);
        const next = page.nextOffset ?? null;
        if (next !== null && next <= offset) throw new Error("LegalWork returned an invalid work page. Refresh to try again.");
        offset = next;
      } while (offset !== null);
      if (!controller.signal.aborted) setItems(work);
    }).catch(reason => { if (!controller.signal.aborted) { setItems([]); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  const openWork = async (item: WorkItem, origin = false) => {
    const found = await requirePairing();
    if (!found) return;
    try {
      await launch(origin ? "resume" : "open", origin ? { conversation: item.originConversationId ?? undefined } : {
        result: JSON.stringify({ kind: "chats", id: item.sessionId, workspaceId: item.workspaceId, sourceId: `local:${item.workspaceId}`, sessionId: item.sessionId }),
      }, found);
    } catch (reason) { await showToast({ style: Toast.Style.Failure, title: "Could not open work", message: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const refreshAction = <Action title="Refresh Work" icon={Icon.ArrowClockwise} onAction={() => setRefresh(value => value + 1)} />;
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." actions={<ActionPanel>{refreshAction}</ActionPanel>} /></List>;
  return <List isLoading={loading} searchBarPlaceholder="Delegated work">
    {items.map(item => <List.Item key={item.id} icon={ICONS[item.status] ?? Icon.Circle} title={item.title} subtitle={item.projectName} accessories={[{ text: item.pendingAttention ? `${item.pendingAttention} waiting for you` : item.status }]}
      actions={<ActionPanel><Action title="Open in LegalWork" icon={Icon.ArrowRight} onAction={() => void openWork(item)} />{item.originConversationId && <Action title="Open Origin Conversation" icon={Icon.Message} onAction={() => void openWork(item, true)} />}{refreshAction}</ActionPanel>} />)}
    {!loading && !items.length && <List.EmptyView title={error ? "Work unavailable" : "No delegated work"} description={error ?? "Work the Assistant starts in your projects appears here."} actions={<ActionPanel>{refreshAction}</ActionPanel>} />}
  </List>;
}
