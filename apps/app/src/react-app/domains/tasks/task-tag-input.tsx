/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 80;

export function TaskTagInput(props: {
  tags: string[];
  suggestions: string[];
  disabled?: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const query = draft.trim();

  const filtered = useMemo(() => {
    const selected = new Set(props.tags.map((tag) => tag.toLocaleLowerCase()));
    const needle = query.toLocaleLowerCase();
    return props.suggestions
      .filter((tag) => !selected.has(tag.toLocaleLowerCase()))
      .filter((tag) => !needle || tag.toLocaleLowerCase().includes(needle))
      .slice(0, 8);
  }, [props.suggestions, props.tags, query]);
  const showCreate =
    query.length > 0 &&
    query.length <= MAX_TAG_LENGTH &&
    !props.tags.some((tag) => tag.toLocaleLowerCase() === query.toLocaleLowerCase()) &&
    !filtered.some((tag) => tag.toLocaleLowerCase() === query.toLocaleLowerCase());
  const items: Array<{ kind: "create" | "existing"; value: string }> = [
    ...(showCreate ? [{ kind: "create" as const, value: query }] : []),
    ...filtered.map((tag) => ({ kind: "existing" as const, value: tag })),
  ];
  const dropdownOpen = open && items.length > 0 && !props.disabled;

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || props.tags.length >= MAX_TAGS) return;
    if (props.tags.some((entry) => entry.toLocaleLowerCase() === tag.toLocaleLowerCase())) return;
    props.onChange([...props.tags, tag]);
    setDraft("");
    setHighlight(0);
  };

  return (
    <div className="relative">
      <div
        className={cn(
          "flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-0 py-1.5",
          "hover:border-border focus-within:border-border focus-within:px-2 focus-within:ring-3 focus-within:ring-ring/30",
          props.disabled && "cursor-default opacity-70",
        )}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !props.disabled) inputRef.current?.focus();
        }}
      >
        {props.tags.map((tag) => (
          <Badge key={tag} variant="outline" className="gap-1 bg-muted/40 px-1.5 py-0.5 text-[11px]">
            {tag}
            {props.disabled ? null : (
              <button
                type="button"
                aria-label={t("tasks.remove_tag", { tag })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onChange(props.tags.filter((entry) => entry !== tag))}
              >
                <X aria-hidden className="size-2.5" />
              </button>
            )}
          </Badge>
        ))}
        {props.disabled || props.tags.length >= MAX_TAGS ? null : (
          <input
            ref={inputRef}
            value={draft}
            maxLength={MAX_TAG_LENGTH}
            aria-label={t("tasks.add_tag")}
            placeholder={props.tags.length ? t("tasks.add_tag") : t("tasks.tags_placeholder")}
            className="min-w-[9ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setDraft(event.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setHighlight((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                addTag((items[highlight] ?? items[0])?.value ?? draft);
              } else if (event.key === "Escape") {
                setOpen(false);
              } else if (event.key === "Backspace" && !draft && props.tags.length) {
                props.onChange(props.tags.slice(0, -1));
              }
            }}
          />
        )}
      </div>
      {dropdownOpen ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {items.map((item, index) => (
            <button
              key={`${item.kind}:${item.value}`}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted",
                index === highlight && "bg-muted",
              )}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(item.value)}
            >
              {item.kind === "create" ? <Plus aria-hidden className="size-3.5 text-muted-foreground" /> : null}
              <span className="truncate">
                {item.kind === "create" ? t("tasks.create_tag", { tag: item.value }) : item.value}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
