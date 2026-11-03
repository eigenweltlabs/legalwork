import { useEffect, useState } from "react";

/** Keep the last action visible through short gaps between tool calls. */
export function useActivityLabel(label: string, waiting: boolean) {
  const [settledLabel, setSettledLabel] = useState(label);
  useEffect(() => {
    if (!waiting) {
      setSettledLabel(label);
      return;
    }
    const timer = window.setTimeout(() => setSettledLabel(label), 500);
    return () => window.clearTimeout(timer);
  }, [label, waiting]);
  return waiting ? settledLabel : label;
}
