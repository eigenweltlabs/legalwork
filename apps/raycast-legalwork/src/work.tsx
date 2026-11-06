import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { launch, readPairing, request, type Pairing, type WorkItem } from "./legalwork";

const ICONS: Record<string, Icon> = { "input-required": Icon.QuestionMark, running: Icon.CircleProgress, queued: Icon.Clock, returned: Icon.CheckCircle, failed: Icon.XMarkCircle, stopped: Icon.Stop, unavailable: Icon.Warning };

export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [items, setItems] = useState<WorkItem[]>([]);
  useEffect(() => { void readPairing().then(async found => { setPairing(found); if (found) {
    const work: WorkItem[] = []; let offset: number | null = 0;
    do { const page: { items: WorkItem[]; nextOffset: number | null } = await request(found, `/assistant/work?limit=100&offset=${offset}`); work.push(...page.items); offset = page.nextOffset ?? null; } while (offset !== null);
    setItems(work);
  } }); }, []);
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." /></List>;
  return <List isLoading={pairing === undefined} searchBarPlaceholder="Delegated work">
    {items.map(item => <List.Item key={item.id} icon={ICONS[item.status] ?? Icon.Circle} title={item.title} subtitle={item.projectName} accessories={[{ text: item.pendingAttention ? `${item.pendingAttention} waiting for you` : item.status }]}
      actions={<ActionPanel><Action title="Open in LegalWork" icon={Icon.ArrowRight} onAction={() => void launch("work", {})} />{item.originConversationId && <Action title="Open Origin Conversation" icon={Icon.Message} onAction={() => void launch("resume", { conversation: item.originConversationId ?? undefined })} />}</ActionPanel>} />)}
    {pairing && !items.length && <List.EmptyView title="No delegated work" description="Work the Assistant starts in your projects appears here." />}
  </List>;
}
