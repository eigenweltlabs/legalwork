/** @jsxImportSource react */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { captureAppError } from "@/app/lib/app-error";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n"
import { addErrorDetailsContext, openErrorReport, recordError } from "@/app/lib/error-reports";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; incidentId: string | null };

/**
 * Top-level error boundary: catches React render/lifecycle crashes (which do
 * not reach window.onerror in production), reports a content-free `app_error`,
 * and shows a fallback instead of a blank screen.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, incidentId: null };

  static getDerivedStateFromError(): State {
    return { hasError: true, incidentId: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    captureAppError("react_render", error);
    const diagnostic = recordError(error);
    addErrorDetailsContext(error, { componentStack: info.componentStack });
    this.setState({ incidentId: diagnostic?.incident_id ?? null });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-sm font-medium text-dls-text">{t("boot.something_went_wrong")}</div>
            {this.state.incidentId ? <Button variant="outline" onClick={() => { if (this.state.incidentId) openErrorReport(this.state.incidentId); }}>{t("error_report.share")}</Button> : null}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-dls-border px-4 py-2 text-[13px] text-dls-text hover:bg-dls-hover"
            >
              {t("boot.reload")}
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
