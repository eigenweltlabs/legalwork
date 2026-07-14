import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {}

/** Clean, flat table root. `w-full`, hairline dividers via the row/cell wrappers. */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, children, ...rest },
  ref,
) {
  return (
    <table
      ref={ref}
      className={cn("w-full border-collapse text-base text-ink", className)}
      {...rest}
    >
      {children}
    </table>
  );
});

export interface THeadProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {
  /** Stick the header to the top of its scroll container. */
  sticky?: boolean;
}

/** Table header group. Pass `sticky` for a pinned header on scroll. */
export const THead = forwardRef<HTMLTableSectionElement, THeadProps>(
  function THead({ className, sticky, children, ...rest }, ref) {
    return (
      <thead
        ref={ref}
        className={cn(
          sticky && "sticky top-0 z-10 bg-surface",
          className,
        )}
        {...rest}
      >
        {children}
      </thead>
    );
  },
);

export interface TBodyProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {}

/** Table body group. */
export const TBody = forwardRef<HTMLTableSectionElement, TBodyProps>(
  function TBody({ className, children, ...rest }, ref) {
    return (
      <tbody ref={ref} className={cn(className)} {...rest}>
        {children}
      </tbody>
    );
  },
);

export interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {}

/** Table row with a hairline bottom divider and a subtle hover wash. */
export const Tr = forwardRef<HTMLTableRowElement, TrProps>(function Tr(
  { className, children, ...rest },
  ref,
) {
  return (
    <tr
      ref={ref}
      className={cn(
        "border-b border-subtle transition-colors duration-[var(--lw-duration-fast)] ease-standard last:border-0 hover:bg-hover",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
});

export interface ThProps
  extends React.ThHTMLAttributes<HTMLTableCellElement> {}

/** Column header cell: small, uppercase, muted label. */
export const Th = forwardRef<HTMLTableCellElement, ThProps>(function Th(
  { className, children, ...rest },
  ref,
) {
  return (
    <th
      ref={ref}
      className={cn(
        "border-b border-subtle px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-tertiary",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
});

export interface TdProps
  extends React.TdHTMLAttributes<HTMLTableCellElement> {}

/** Body data cell. */
export const Td = forwardRef<HTMLTableCellElement, TdProps>(function Td(
  { className, children, ...rest },
  ref,
) {
  return (
    <td
      ref={ref}
      className={cn("px-3 py-2.5 align-middle text-ink", className)}
      {...rest}
    >
      {children}
    </td>
  );
});
