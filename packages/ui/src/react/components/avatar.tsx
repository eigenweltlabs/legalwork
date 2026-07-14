import { forwardRef } from "react";
import { cn } from "../utils/cn";

const sizes = {
  xs: "size-5 text-2xs rounded-md",
  sm: "size-6 text-xs rounded-md",
  md: "size-8 text-sm rounded-lg",
  lg: "size-10 text-base rounded-xl",
} as const;

/** Deterministic navy/blue-family gradient from a string seed. */
const palette = [
  "linear-gradient(135deg, #011627 0%, #0d2942 100%)",
  "linear-gradient(135deg, #0a58c2 0%, #0967c6 100%)",
  "linear-gradient(135deg, #163a5c 0%, #2e5c85 100%)",
  "linear-gradient(135deg, #12a150 0%, #0b7a3c 100%)",
  "linear-gradient(135deg, #6c6c76 0%, #35353b 100%)",
];
function seedGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  name?: string;
  src?: string;
  size?: keyof typeof sizes;
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { className, name = "", src, size = "md", style, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold text-white",
        sizes[size],
        className,
      )}
      style={src ? style : { backgroundImage: seedGradient(name), ...style }}
      {...rest}
    >
      {src ? (
        <img src={src} alt={name} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
});
