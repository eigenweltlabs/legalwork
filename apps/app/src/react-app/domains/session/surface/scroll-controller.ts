import { useCallback, useEffect, useRef, type RefObject, type UIEventHandler } from "react";

import { getSessionScrollState, useSessionScrollStore, type SessionScrollState } from "./scroll-store";

function readScrollState(sessionId: string | null): SessionScrollState {
  return getSessionScrollState(useSessionScrollStore.getState().sessions, sessionId);
}

function isStickyBottom(sessionId: string | null) {
  return readScrollState(sessionId).mode === "stickyBottom";
}

// Widened from 1px: WKWebView (the Office task pane) uses fractional pixel
// metrics and Office UI scaling, which leave a several-px residual gap even
// when pinned to the bottom. With a 1px tolerance sticky mode could never
// re-arm there, permanently disabling autoscroll after any manual scroll.
// Kept well below a text line (~19px) so it never falsely claims bottom.
const EXACT_BOTTOM_GAP_PX = 8;
// Widened from 250ms so a single wheel or trackpad flick isn't missed between
// two rapid programmatic scroll-to-bottom frames during streaming.
const SCROLL_GESTURE_WINDOW_MS = 600;
// Threshold (px) that counts as a meaningful "scroll upward" gesture. Anything
// smaller is treated as anchoring jitter and ignored so we don't trip out of
// sticky bottom mode for pixel-level content growth.
const MANUAL_BROWSE_UPWARD_THRESHOLD_PX = 16;

type SessionScrollControllerOptions = {
  selectedSessionId: string | null;
  renderedMessages: unknown;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
};

function scrollBottomGap(container: HTMLElement) {
  return container.scrollHeight - (container.scrollTop + container.clientHeight);
}

function isExactlyAtBottom(container: HTMLElement) {
  return scrollBottomGap(container) <= EXACT_BOTTOM_GAP_PX;
}

function messageIdForElement(element: HTMLElement) {
  const id = element.getAttribute("data-message-id")?.trim();
  return id && id.length > 0 ? id : null;
}

function latestMessageElement(container: HTMLElement) {
  const messageEls = container.querySelectorAll("[data-message-id]");
  for (let index = messageEls.length - 1; index >= 0; index -= 1) {
    const element = messageEls.item(index);
    if (element instanceof HTMLElement) return element;
  }
  return null;
}

function messageElementById(container: HTMLElement, messageId: string) {
  const messageEls = container.querySelectorAll("[data-message-id]");
  for (const element of messageEls) {
    if (!(element instanceof HTMLElement)) continue;
    if (messageIdForElement(element) === messageId) return element;
  }
  return null;
}

function latestMessageTopClippedId(container: HTMLElement) {
  const latestMessage = latestMessageElement(container);
  if (!latestMessage) return null;

  const messageId = messageIdForElement(latestMessage);
  if (!messageId) return null;

  const containerRect = container.getBoundingClientRect();
  const latestRect = latestMessage.getBoundingClientRect();
  const lastMessageDoesNotFit = latestRect.height > containerRect.height + 1;
  const startVisible = latestRect.top >= containerRect.top - 1 && latestRect.top <= containerRect.bottom + 1;

  return lastMessageDoesNotFit && !startVisible ? messageId : null;
}

export function useSessionScrollController(
  options: SessionScrollControllerOptions,
) {
  const selectedSessionId = options.selectedSessionId;
  const setStickyBottom = useSessionScrollStore((state) => state.setStickyBottom);
  const setManualScroll = useSessionScrollStore((state) => state.setManualScroll);
  const setTopClippedMessageId = useSessionScrollStore((state) => state.setTopClippedMessageId);

  const lastKnownScrollTopRef = useRef(0);
  const lastKnownScrollHeightRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollResetRafARef = useRef<number | undefined>(undefined);
  const programmaticScrollResetRafBRef = useRef<number | undefined>(undefined);
  const observedContentHeightRef = useRef(0);
  const lastGestureAtRef = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);

  const hasScrollGesture = useCallback(
    () => Date.now() - lastGestureAtRef.current < SCROLL_GESTURE_WINDOW_MS,
    [],
  );

  const updateOverflowAnchor = useCallback(() => {
    const container = options.containerRef.current;
    if (!container) return;
    container.style.overflowAnchor = isStickyBottom(selectedSessionId) ? "none" : "auto";
  }, [options.containerRef, selectedSessionId]);

  const markScrollGesture = useCallback(
    (target?: EventTarget | null) => {
      const container = options.containerRef.current;
      if (!container) return;

      const el = target instanceof Element ? target : undefined;
      const nested = el?.closest("[data-scrollable]");
      if (nested && nested !== container) return;

      lastGestureAtRef.current = Date.now();
    },
    [options.containerRef],
  );

  const clearProgrammaticScrollReset = useCallback(() => {
    if (programmaticScrollResetRafARef.current !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafARef.current);
      programmaticScrollResetRafARef.current = undefined;
    }
    if (programmaticScrollResetRafBRef.current !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafBRef.current);
      programmaticScrollResetRafBRef.current = undefined;
    }
  }, []);

  const releaseProgrammaticScrollSoon = useCallback(() => {
    clearProgrammaticScrollReset();
    programmaticScrollResetRafARef.current = window.requestAnimationFrame(() => {
      programmaticScrollResetRafARef.current = undefined;
      programmaticScrollResetRafBRef.current = window.requestAnimationFrame(() => {
        programmaticScrollResetRafBRef.current = undefined;
        programmaticScrollRef.current = false;
      });
    });
  }, [clearProgrammaticScrollReset]);

  const refreshTopClippedMessage = useCallback(() => {
    const container = options.containerRef.current;
    const nextId = container ? latestMessageTopClippedId(container) : null;
    setTopClippedMessageId(selectedSessionId, nextId);
    return nextId;
  }, [options.containerRef, selectedSessionId, setTopClippedMessageId]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = options.containerRef.current;
      if (!container) return;

      setStickyBottom(selectedSessionId, null);
      programmaticScrollRef.current = true;

      if (behavior === "smooth") {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        releaseProgrammaticScrollSoon();
        return;
      }

      // Re-assert the bottom across a few frames: WKWebView (the Office
      // pane) can finish laying out freshly mounted rows (e.g. the thinking
      // indicator) a frame after the first set, leaving the tail clipped if
      // we only settle once.
      container.scrollTop = container.scrollHeight;
      lastKnownScrollTopRef.current = container.scrollTop;
      let settleFramesLeft = 3;
      const settle = () => {
        const next = options.containerRef.current;
        if (!next) {
          programmaticScrollRef.current = false;
          return;
        }
        next.scrollTop = next.scrollHeight;
        lastKnownScrollTopRef.current = next.scrollTop;
        settleFramesLeft -= 1;
        if (settleFramesLeft > 0) {
          window.requestAnimationFrame(settle);
          return;
        }
        refreshTopClippedMessage();
        releaseProgrammaticScrollSoon();
      };
      window.requestAnimationFrame(settle);
    },
    [options.containerRef, refreshTopClippedMessage, releaseProgrammaticScrollSoon, selectedSessionId, setStickyBottom],
  );

  const saveScrollPosition = useCallback(
    (container: HTMLDivElement) => {
      const nextTopClippedMessageId = latestMessageTopClippedId(container);
      if (isExactlyAtBottom(container)) {
        setStickyBottom(selectedSessionId, nextTopClippedMessageId);
      } else {
        setManualScroll(selectedSessionId, container.scrollTop, nextTopClippedMessageId);
      }
      return nextTopClippedMessageId;
    },
    [selectedSessionId, setManualScroll, setStickyBottom],
  );

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const container = event.currentTarget;
      const currentTop = container.scrollTop;
      const previousTop = lastKnownScrollTopRef.current;
      const delta = currentTop - previousTop;
      const userGestured = hasScrollGesture();

      // Layout changes (a streaming tool card collapsing, step runs being
      // regrouped, turn-end chrome unmounting) clamp scrollTop and fire
      // scroll events with negative deltas that look exactly like the user
      // scrolling up. Which heights those events observe is timing- and
      // engine-dependent (WKWebView delivers them after later growth has
      // already been applied), so height heuristics cannot reliably tell
      // layout from intent. Only a real input gesture (wheel, touch,
      // scrollbar) may ever demote sticky-bottom to manual browsing.
      const currentHeight = container.scrollHeight;
      const previousHeight = lastKnownScrollHeightRef.current || currentHeight;
      lastKnownScrollHeightRef.current = currentHeight;
      const contentShrank = currentHeight < previousHeight - 1;
      const scrolledUp = userGestured && delta <= -MANUAL_BROWSE_UPWARD_THRESHOLD_PX;

      // If the user scrolls up meaningfully while a programmatic scroll is
      // in flight, abandon the programmatic state and switch to manual browse
      // immediately. Without this the ResizeObserver's auto-scroll during
      // streaming keeps re-anchoring us to the bottom and the user can never
      // actually get away from the tail of the transcript. Downward gestures
      // are not an escape: wheeling toward the tail means "keep following".
      if (programmaticScrollRef.current && (scrolledUp || (userGestured && delta < 0))) {
        programmaticScrollRef.current = false;
        clearProgrammaticScrollReset();
        saveScrollPosition(container);
        lastKnownScrollTopRef.current = currentTop;
        return;
      }

      if (programmaticScrollRef.current) {
        lastKnownScrollTopRef.current = currentTop;
        refreshTopClippedMessage();
        return;
      }

      if (!userGestured && !scrolledUp) {
        if (isExactlyAtBottom(container)) {
          setStickyBottom(selectedSessionId, latestMessageTopClippedId(container));
        } else if (contentShrank && isStickyBottom(selectedSessionId)) {
          // A layout shrink clamped us away from the bottom while following
          // the stream. The ResizeObserver only re-anchors on growth, so
          // re-pin here or a turn that ends with a collapse leaves the
          // transcript hovering above the bottom.
          scrollToBottom("auto");
        } else {
          refreshTopClippedMessage();
        }
        lastKnownScrollTopRef.current = currentTop;
        return;
      }

      // Downward gestures never demote sticky-bottom: the user is chasing
      // the tail, and during tool-call streaming content grows in large
      // jumps, so the moving bottom is rarely within the at-bottom epsilon
      // at the moment the scroll event is handled. Only upward movement
      // switches to manual browsing.
      if (delta >= 0) {
        if (isExactlyAtBottom(container)) {
          setStickyBottom(selectedSessionId, latestMessageTopClippedId(container));
        } else if (!isStickyBottom(selectedSessionId)) {
          setManualScroll(selectedSessionId, currentTop, latestMessageTopClippedId(container));
        } else {
          refreshTopClippedMessage();
        }
        lastKnownScrollTopRef.current = currentTop;
        return;
      }

      saveScrollPosition(container);
      lastKnownScrollTopRef.current = currentTop;
    },
    [clearProgrammaticScrollReset, hasScrollGesture, refreshTopClippedMessage, saveScrollPosition, scrollToBottom, selectedSessionId, setManualScroll, setStickyBottom],
  );

  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  const jumpToStartOfMessage = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const messageId = readScrollState(selectedSessionId).topClippedMessageId;
      const container = options.containerRef.current;
      if (!messageId || !container) return;

      const target = messageElementById(container, messageId);
      if (!target) return;

      setManualScroll(selectedSessionId, container.scrollTop, messageId);
      target.scrollIntoView({ behavior, block: "start" });
    },
    [options.containerRef, selectedSessionId, setManualScroll],
  );

  useEffect(() => {
    updateOverflowAnchor();
    return useSessionScrollStore.subscribe(updateOverflowAnchor);
  }, [updateOverflowAnchor]);

  useEffect(() => {
    const content = options.contentRef.current;
    if (!content) return;

    observedContentHeightRef.current = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextContent = options.contentRef.current;
      if (!nextContent) return;

      const nextHeight = nextContent.offsetHeight;
      const previousContentHeight = observedContentHeightRef.current;
      const heightChanged = Math.abs(nextHeight - previousContentHeight) > 1;
      observedContentHeightRef.current = nextHeight;

      // Only re-anchor to the bottom when we're already in sticky bottom mode
      // AND the user isn't actively scrolling. If they've touched the wheel,
      // touchpad, or scrollbar in the last SCROLL_GESTURE_WINDOW_MS, treat
      // that as intent to break out of autoscroll and leave their position
      // alone until the next handleScroll tick reclassifies the mode.
      // Shrinks re-anchor too: when a turn completes, streaming chrome
      // (thinking indicator, running-tool state) unmounts and the content
      // gets shorter. Chromium clamps scrollTop and fires a scroll event our
      // handler compensates for, but WKWebView (the Office pane) clamps
      // without a reliable scroll event, leaving the transcript hovering
      // above the bottom with autoscroll seemingly dead.
      if (heightChanged && isStickyBottom(selectedSessionId) && !hasScrollGesture()) {
        scrollToBottom("auto");
        return;
      }

      refreshTopClippedMessage();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [hasScrollGesture, options.contentRef, refreshTopClippedMessage, scrollToBottom, selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId === previousSessionIdRef.current) return;
    previousSessionIdRef.current = selectedSessionId;
    if (!selectedSessionId) return;

    observedContentHeightRef.current = 0;
    lastKnownScrollTopRef.current = 0;
    lastKnownScrollHeightRef.current = 0;
    queueMicrotask(() => {
      const container = options.containerRef.current;
      if (!container) return;

      const savedState = getSessionScrollState(useSessionScrollStore.getState().sessions, selectedSessionId);
      if (savedState.mode === "manual") {
        programmaticScrollRef.current = true;
        container.scrollTop = Math.min(savedState.scrollTop, Math.max(0, container.scrollHeight - container.clientHeight));
        lastKnownScrollTopRef.current = container.scrollTop;
        window.requestAnimationFrame(() => {
          const next = options.containerRef.current;
          if (!next) {
            programmaticScrollRef.current = false;
            return;
          }
          next.scrollTop = Math.min(savedState.scrollTop, Math.max(0, next.scrollHeight - next.clientHeight));
          lastKnownScrollTopRef.current = next.scrollTop;
          saveScrollPosition(next);
          releaseProgrammaticScrollSoon();
        });
        return;
      }

      scrollToBottom("auto");
    });
  }, [options.containerRef, releaseProgrammaticScrollSoon, saveScrollPosition, scrollToBottom, selectedSessionId]);

  useEffect(() => {
    void options.renderedMessages;
    // Convergence invariant: while following and untouched, every message
    // update must end with the transcript at the bottom. This catches
    // growth the ResizeObserver's re-anchor missed because the engine
    // (WKWebView) finished layout after the pin had already settled.
    queueMicrotask(() => {
      refreshTopClippedMessage();
      const container = options.containerRef.current;
      if (!container) return;
      if (isStickyBottom(selectedSessionId) && !hasScrollGesture() && !isExactlyAtBottom(container)) {
        scrollToBottom("auto");
      }
    });
  }, [hasScrollGesture, options.containerRef, options.renderedMessages, refreshTopClippedMessage, scrollToBottom, selectedSessionId]);

  useEffect(() => {
    return () => {
      clearProgrammaticScrollReset();
    };
  }, [clearProgrammaticScrollReset]);

  return {
    handleScroll,
    markScrollGesture,
    scrollToBottom,
    jumpToLatest,
    jumpToStartOfMessage,
  };
}
