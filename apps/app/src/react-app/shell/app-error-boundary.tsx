/** @jsxImportSource react */
import { Component, type ReactNode } from "react";

import { captureAppError } from "@/app/lib/app-error";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean };

/**
 * Top-level error boundary: catches React render/lifecycle crashes (which do
 * not reach window.onerror in production), reports a content-free `app_error`,
 * and shows a fallback instead of a blank screen.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    captureAppError("react_render", error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-sm font-medium text-dls-text">Something went wrong.</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-dls-border px-4 py-2 text-[13px] text-dls-text hover:bg-dls-hover"
            >
              Reload
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
