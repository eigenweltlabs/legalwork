import { describe, expect, test } from "bun:test";
import { toast as sonnerToast } from "sonner";

import { toast } from "../src/components/ui/sonner";

// sonner's Observer notifies subscribers via requestAnimationFrame, which bun's
// test runtime doesn't provide. The assertions below only rely on synchronous
// Observer state (toasts + dismissedToasts), but dismiss() still calls rAF.
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number) as typeof requestAnimationFrame;
}

describe("sonner toast wrapper", () => {
  test("the stored toast carries the id the wrapper returns (X button can dismiss it)", () => {
    // Regression: passing a literal `id: undefined` through to sonner's
    // custom() clobbered the generated id (`{jsx: jsx(id), id, ...data}`), so
    // the stored toast got a different id than the one the ToastCard's X
    // button dismisses. Error toasts with duration: Infinity then could never
    // be closed (issue #62, "clicking the X icon does nothing").
    const returned = toast.error("OpenCode unavailable", {
      description: "engine down",
      action: { label: "Retry", onClick: () => {} },
      duration: Infinity,
    });

    const active = sonnerToast.getToasts();
    expect(active.some((entry) => entry.id === returned)).toBe(true);

    sonnerToast.dismiss(returned);
    expect(sonnerToast.getToasts().some((entry) => entry.id === returned)).toBe(false);
  });

  test("an explicit toast id is preserved", () => {
    const returned = toast("summary", { id: "legalwork-notification-alert" });
    expect(returned).toBe("legalwork-notification-alert");
    expect(sonnerToast.getToasts().some((entry) => entry.id === returned)).toBe(true);
    sonnerToast.dismiss(returned);
    expect(sonnerToast.getToasts().some((entry) => entry.id === returned)).toBe(false);
  });
});
