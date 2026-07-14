import { forwardRef } from "react";
import { Search } from "lucide-react";
import { Input, type InputProps } from "./input";

/** Convenience wrapper: an Input pre-filled with a leading search glyph. */
export const SearchInput = forwardRef<HTMLInputElement, Omit<InputProps, "leading">>(
  function SearchInput({ placeholder = "Search", type = "search", ...rest }, ref) {
    return <Input ref={ref} leading={<Search />} placeholder={placeholder} type={type} {...rest} />;
  },
);
