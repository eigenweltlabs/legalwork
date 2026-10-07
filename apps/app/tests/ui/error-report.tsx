/** Local-only UI fixture. No production requests; uses the actual report dialog. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "@/components/ui/sonner";
import { ErrorReportHost, RecentErrorsButton } from "@/react-app/shell/error-report-dialog";
import { AppErrorBoundary } from "@/react-app/shell/app-error-boundary";
import { initErrorAnalytics } from "@/app/lib/app-error";
import { recordError, clearLocalErrorReports } from "@/app/lib/error-reports";
import { setLocale } from "@/i18n";
import "../../src/app/index.css";

window.localStorage.setItem("legalwork.preferences", JSON.stringify({ analyticsEnabled: false }));
setLocale("en"); clearLocalErrorReports(); initErrorAnalytics();
let rejectDelivery = false;
let manualRequests = 0;
let automaticRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).includes("posthog")) {
    const body = String(init?.body);
    if (body.includes('"error_origin":"manual"')) manualRequests++;
    else automaticRequests++;
    const state = document.getElementById("delivery-state");
    if (state) state.textContent = JSON.stringify({ manualRequests, automaticRequests, payload: JSON.parse(body) }, null, 2);
    return new Response(null, { status: rejectDelivery ? 503 : 200 });
  }
  return realFetch(input, init);
};
function Crasher({ crash }: { crash: boolean }) { if (crash) throw new TypeError("PRIVATE_DOCUMENT_CANARY"); return <p>The renderer is running.</p>; }
function Fixture() {
  const [crash, setCrash] = useState(false);
  const [offline, setOffline] = useState(false);
  const trigger = () => recordError({ name: "APIError", data: { statusCode: 400, message: "tools.0.input_schema must not contain anyOf", responseBody: JSON.stringify({ error: { metadata: { flagged_input: "PRIVATE_DOCUMENT_CANARY" } } }) } }, { source: "session_error", operation: "run", component: "engine", providerId: "custom_client_name", modelId: "anthropic/claude-opus-4.6", baseURL: "https://openrouter.ai/api/v1" });
  return <><ErrorReportHost /><Toaster /><main className="mx-auto max-w-2xl space-y-5 p-10"><h1 className="text-xl font-medium">Error reporting · local verification</h1><p>Analytics is off. PostHog requests are intercepted by a local stub.</p><div className="flex flex-wrap gap-3"><Button onClick={trigger}>Provider 400</Button><Button variant="outline" onClick={() => toast.error("Upload failed", { error: new DOMException("PRIVATE_DOCUMENT_CANARY", "TimeoutError"), operation: "file_upload" })}>Upload timeout</Button><Button variant="outline" onClick={() => setCrash(true)}>Crash renderer</Button><Button variant="outline" onClick={() => { rejectDelivery = !offline; setOffline(!offline); }}>{offline ? "PostHog: unavailable" : "PostHog: available"}</Button></div><RecentErrorsButton /><AppErrorBoundary><Crasher crash={crash} /></AppErrorBoundary><details><summary>Delivery state</summary><pre id="delivery-state" className="max-h-60 overflow-auto text-xs">No error sent.</pre></details></main></>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
