import { useState } from "react";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { cn } from "../utils/cn";
import { IconButton } from "./icon-button";

export interface ComposerProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Row of plugin pills / context chips above the input. */
  pills?: React.ReactNode;
  /** Controls shown to the left of mic + send (e.g. a ModelChip). */
  toolbar?: React.ReactNode;
  /** Left control; defaults to a "+" add button. */
  leadingAction?: React.ReactNode;
  onMic?: () => void;
  showMic?: boolean;
  className?: string;
}

/**
 * Prompt composer — rounded container with an optional plugin-pill row, an
 * auto-sizing input, and a bottom action bar (add · toolbar · mic · send).
 * Enter submits; Shift+Enter inserts a newline.
 */
export function Composer({
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  placeholder = "Ask anything",
  disabled,
  pills,
  toolbar,
  leadingAction,
  onMic,
  showMic = true,
  className,
}: ComposerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const text = value !== undefined ? value : internal;
  const setText = (v: string) => {
    if (value === undefined) setInternal(v);
    onValueChange?.(v);
  };
  const submit = () => {
    if (disabled || !text.trim()) return;
    onSubmit?.(text);
    if (value === undefined) setInternal("");
  };

  return (
    <div
      className={cn(
        "rounded-3xl border border-line bg-surface p-2.5 shadow-sm transition-shadow",
        "focus-within:border-strong focus-within:shadow-md",
        className,
      )}
    >
      {pills ? <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1">{pills}</div> : null}

      <textarea
        rows={1}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="max-h-40 min-h-[40px] w-full resize-none border-0 bg-transparent px-2.5 py-1.5 text-md text-ink outline-none placeholder:text-placeholder"
      />

      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <div className="flex items-center gap-1">
          {leadingAction ?? (
            <IconButton aria-label="Add attachment" variant="ghost">
              <Plus />
            </IconButton>
          )}
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {showMic ? (
            <IconButton aria-label="Dictate" variant="ghost" onClick={onMic}>
              <Mic />
            </IconButton>
          ) : null}
          <IconButton
            aria-label="Send"
            variant="accent"
            shape="round"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            <ArrowUp />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
