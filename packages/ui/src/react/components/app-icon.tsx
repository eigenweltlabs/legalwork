import { forwardRef } from "react";
import { cn } from "../utils/cn";

const sizes = {
  sm: "size-7 rounded-lg text-xs [&_svg]:size-4",
  md: "size-9 rounded-xl text-sm [&_svg]:size-5",
  lg: "size-11 rounded-2xl text-base [&_svg]:size-6",
} as const;

export interface AppIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: keyof typeof sizes;
  /** Solid background color or CSS gradient. Defaults to navy gradient. */
  color?: string;
  /** Optional image source (favicon / logo). Overrides children. */
  src?: string;
  children?: React.ReactNode;
}

/**
 * Rounded-square app/plugin icon tile (the installed-plugins row + composer
 * plugin pills in the reference). macOS-style: subtle inner hairline + soft
 * bottom shadow to read as a physical tile.
 */
export const AppIcon = forwardRef<HTMLSpanElement, AppIconProps>(function AppIcon(
  { className, size = "md", color, src, children, style, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold text-white",
        "shadow-[0_1px_2px_rgba(16,24,40,0.14)] ring-1 ring-inset ring-white/12",
        sizes[size],
        className,
      )}
      style={{
        background: src ? undefined : color ?? "linear-gradient(135deg,#011627,#0d2942)",
        ...style,
      }}
      {...rest}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : children}
    </span>
  );
});
