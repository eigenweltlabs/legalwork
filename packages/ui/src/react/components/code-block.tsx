import { forwardRef, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../utils/cn";

/** Inline code chip for prose, e.g. <InlineCode>matter.status</InlineCode>. */
export interface InlineCodeProps extends React.HTMLAttributes<HTMLElement> {}

export const InlineCode = forwardRef<HTMLElement, InlineCodeProps>(
  function InlineCode({ className, children, ...rest }, ref) {
    return (
      <code
        ref={ref}
        className={cn(
          "rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.85em] text-ink",
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
);

/** Block of monospaced code with an optional header (filename + copy). No syntax highlighting. */
export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The code text to render verbatim. */
  code: string;
  /** Optional language label, shown in the header when no filename is set. */
  language?: string;
  /** Optional filename shown on the left of the header bar. */
  filename?: string;
  /** Whether to show the copy button (and therefore the header bar). Default true. */
  copyable?: boolean;
}

export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(
  function CodeBlock(
    { className, code, language, filename, copyable = true, ...rest },
    ref,
  ) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const copy = () => {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    };

    const label = filename ?? language;
    const showHeader = copyable || Boolean(label);

    return (
      <div
        ref={ref}
        className={cn(
          "overflow-hidden rounded-xl border border-subtle",
          className,
        )}
        {...rest}
      >
        {showHeader ? (
          <div className="flex items-center justify-between bg-sunken px-3 py-1.5 text-xs text-subtext">
            <span className="truncate font-medium">{label}</span>
            {copyable ? (
              <button
                type="button"
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy code"}
                className={cn(
                  "-mr-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium",
                  "text-tertiary transition-colors duration-[var(--lw-duration-fast)] ease-standard",
                  "hover:bg-hover hover:text-ink outline-none",
                  "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
                  "[&_svg]:size-3.5",
                )}
              >
                {copied ? (
                  <>
                    <Check className="text-success" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy />
                    Copy
                  </>
                )}
              </button>
            ) : null}
          </div>
        ) : null}
        <pre className="overflow-x-auto bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    );
  },
);
