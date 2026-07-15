/** @jsxImportSource react */
/**
 * Multi-select "Share with your firm" dialog. Lists this workspace's local
 * skills, MCP servers and plugins with checkboxes (+ select-all) and pushes the
 * selected items to the team hub in one batch. MCP servers that carry a key get
 * an "Include key" switch — when on, the fully-configured entry is shared
 * (encrypted, any firm member may copy); otherwise a secret-free template is
 * shared and installers add their own key.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import type {
  EigenweltHubShareItem,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";

type Selectable = {
  ref: string;
  label: string;
  kind: "skill" | "workflow" | "mcp" | "plugin";
  hasSecret?: boolean;
};

/** An MCP config carries a secret if it has non-empty env/headers or a secret-shaped key. */
function mcpHasSecret(config: Record<string, unknown>): boolean {
  const scan = (v: unknown, inAuthMap: boolean): boolean => {
    if (typeof v === "string") {
      if (inAuthMap && v.trim() !== "") return true;
      if (/(?:\bBearer\s+\S+|\b(?:ghp|gho|github_pat|xox[baprs]|sk|rk|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,})/.test(v)) return true;
      if (/^https?:\/\//i.test(v)) {
        try {
          const url = new URL(v);
          if (url.username || url.password) return true;
          if ([...url.searchParams.keys()].some((key) => /(?:api[_-]?key|secret|token|password|authorization|credential|^key$)/i.test(key))) return true;
        } catch {
          // Invalid URLs are handled by the server-side MCP validator.
        }
      }
      return false;
    }
    if (Array.isArray(v)) {
      return v.some((x, index) => {
        if (typeof x === "string" && /^--?(?:api[_-]?key|secret|token|password|authorization|credential|key)(?:=|$)/i.test(x)) return true;
        const previous = typeof v[index - 1] === "string" ? String(v[index - 1]) : "";
        return /^--?(?:api[_-]?key|secret|token|password|authorization|credential|key)$/i.test(previous) || scan(x, false);
      });
    }
    if (v && typeof v === "object") {
      return Object.entries(v as Record<string, unknown>).some(([k, child]) => {
        if (/(api[_-]?key|secret|token|password|authorization|bearer|credential|private[_-]?key|^key$)/i.test(k) && typeof child === "string" && child.trim()) return true;
        return scan(child, k.toLowerCase() === "env" || k.toLowerCase() === "headers");
      });
    }
    return false;
  };
  return scan(config, false);
}

export function HubShareDialog(props: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSelection?: { kind: Selectable["kind"]; ref: string } | null;
  onShared?: () => void;
}) {
  const { client, workspaceId } = props;
  const initialSelection = props.initialSelection;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<Selectable[]>([]);
  const [mcps, setMcps] = useState<Selectable[]>([]);
  const [plugins, setPlugins] = useState<Selectable[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeKey, setIncludeKey] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!props.open || !client || !workspaceId) return;
    let cancelled = false;
    // Consent is per publish action; cancelling and reopening must not silently
    // preserve an earlier acknowledgement or selection.
    setSelected(
      props.initialSelection
        ? new Set([`${props.initialSelection.kind}:${props.initialSelection.ref}`])
        : new Set(),
    );
    setIncludeKey(new Set());
    setAcknowledged(false);
    setSkills([]);
    setMcps([]);
    setPlugins([]);
    setLoading(true);
    void (async () => {
      try {
        const loadSkills = !initialSelection
          || initialSelection.kind === "skill"
          || initialSelection.kind === "workflow";
        const loadMcps = !initialSelection || initialSelection.kind === "mcp";
        const loadPlugins = !initialSelection || initialSelection.kind === "plugin";
        const [s, m, p] = await Promise.all([
          loadSkills ? client.listSkills(workspaceId) : Promise.resolve(null),
          loadMcps ? client.listMcp(workspaceId) : Promise.resolve(null),
          loadPlugins
            ? client.listPlugins(workspaceId, { includeGlobal: initialSelection?.kind === "plugin" })
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSkills(s ? s.items.filter((it) => !initialSelection || it.name === initialSelection.ref).map((it) => {
          const initialKind = initialSelection?.ref === it.name
            && (initialSelection.kind === "skill" || initialSelection.kind === "workflow")
            ? initialSelection.kind
            : undefined;
          return {
            ref: it.name,
            label: it.name,
            kind: initialKind ?? (it.kind === "workflow" ? "workflow" as const : "skill" as const),
          };
        }) : []);
        setMcps(m ? m.items
          .filter((it) => !initialSelection || it.name === initialSelection.ref)
          .map((it) => ({ ref: it.name, label: it.name, kind: "mcp" as const, hasSecret: mcpHasSecret(it.config) })) : []);
        setPlugins(p ? p.items
          .filter((it) => !initialSelection || it.spec === initialSelection.ref || it.path === initialSelection.ref)
          .map((it) => ({ ref: it.spec, label: it.path ?? it.spec, kind: "plugin" as const })) : []);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load local items.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open, initialSelection, client, workspaceId]);

  const all = useMemo(() => [...skills, ...mcps, ...plugins], [skills, mcps, plugins]);
  const key = (it: Selectable) => `${it.kind}:${it.ref}`;
  const singleItem = initialSelection
    ? all.find((it) => key(it) === `${initialSelection.kind}:${initialSelection.ref}`)
    : undefined;
  const candidates = initialSelection ? (singleItem ? [singleItem] : []) : all;
  const selectedItems = candidates.filter((it) => selected.has(key(it)));

  const toggle = (it: Selectable) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = key(it);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const selectAll = () =>
    setSelected((prev) => (prev.size === all.length ? new Set() : new Set(all.map(key))));

  const share = async () => {
    if (!client || !workspaceId) return;
    const items: EigenweltHubShareItem[] = selectedItems.map((it) => ({
      kind: it.kind,
      ref: it.ref,
      ...(it.kind === "mcp" && includeKey.has(key(it)) ? { includeSecret: true, allow: "all" as const } : {}),
    }));
    if (items.length === 0) return;
    setBusy(true);
    try {
      const { results } = await client.hubShareBatch(workspaceId, items);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (ok > 0) toast.success(`Shared ${ok} item${ok === 1 ? "" : "s"} with your firm.`);
      if (failed.length > 0) toast.error(`${failed.length} failed: ${failed[0]?.error ?? ""}`);
      props.onShared?.();
      props.onOpenChange(false);
      setSelected(new Set());
      setIncludeKey(new Set());
      setAcknowledged(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Share failed.");
    } finally {
      setBusy(false);
    }
  };

  const Section = ({ title, items }: { title: string; items: Selectable[] }) =>
    items.length === 0 ? null : (
      <div className="space-y-1">
        <div className="text-2xs font-semibold uppercase tracking-wide text-tertiary">{title}</div>
        {items.map((it) => {
          const k = key(it);
          return (
            <label key={k} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
              <Checkbox checked={selected.has(k)} onCheckedChange={() => toggle(it)} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{it.label}</span>
              {it.kind === "mcp" && it.hasSecret ? (
                <span className="flex items-center gap-1.5 text-2xs text-subtext">
                  Include key
                  <Switch
                    checked={includeKey.has(k)}
                    onCheckedChange={(on) =>
                      setIncludeKey((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(k);
                        else next.delete(k);
                        return next;
                      })
                    }
                  />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share with your firm</DialogTitle>
          <DialogDescription>
            {initialSelection
              ? "Review this item and remove client data or credentials before publishing."
              : "Shared skills can contain instructions and plugins can execute code. Review the selected items and remove client data or credentials before publishing."}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-subtext">
            <Loader2 className="size-4 animate-spin" /> Loading your local items…
          </div>
        ) : initialSelection && !singleItem ? (
          <div className="py-8 text-center text-sm text-subtext">This item is no longer available.</div>
        ) : all.length === 0 ? (
          <div className="py-8 text-center text-sm text-subtext">Nothing local to share yet.</div>
        ) : singleItem ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-dls-border p-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{singleItem.label}</span>
              <Badge variant="outline">
                {singleItem.kind === "workflow"
                  ? "Workflow"
                  : singleItem.kind === "mcp"
                    ? "MCP server"
                    : singleItem.kind === "plugin"
                      ? "Plugin"
                      : "Skill"}
              </Badge>
              {singleItem.kind === "mcp" && singleItem.hasSecret ? (
                <span className="flex items-center gap-1.5 text-2xs text-subtext">
                  Include key
                  <Switch
                    checked={includeKey.has(key(singleItem))}
                    onCheckedChange={(on) =>
                      setIncludeKey((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(key(singleItem));
                        else next.delete(key(singleItem));
                        return next;
                      })
                    }
                  />
                </span>
              ) : null}
            </div>
            <label className="flex items-start gap-2 rounded-lg border border-dls-border p-3 text-xs text-subtext">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <span>
                I reviewed this item. Included MCP keys will be encrypted but can be copied by every authorized firm member.
              </span>
            </label>
          </div>
        ) : (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
            <div className="flex items-center justify-between">
              <button type="button" className="text-xs text-brand hover:underline" onClick={selectAll}>
                {selected.size === all.length ? "Clear all" : "Select all"}
              </button>
              <Badge variant="outline">{selected.size} selected</Badge>
            </div>
            <Section title="Skills" items={skills} />
            <Section title="MCP servers" items={mcps} />
            <Section title="Plugins" items={plugins} />
            <label className="flex items-start gap-2 rounded-lg border border-dls-border p-3 text-xs text-subtext">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <span>
                I reviewed these files and configurations. Included MCP keys will be encrypted but can be copied by every authorized firm member.
              </span>
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || selectedItems.length === 0 || !acknowledged} onClick={() => void share()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {initialSelection ? "Share" : `Share${selectedItems.length > 0 ? ` (${selectedItems.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
