// Interactive artifacts keep local JavaScript, styles, and embedded assets, but
// cannot fetch remote code or send workspace content through network resources.
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function offlinePreviewDocument(content: string) {
  // Put the policy before any attacker-controlled element, including <base>,
  // external scripts and other meta policies. Later policies cannot relax it.
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${content}`;
}

export function sourcePdfPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || /[\0-\x1f]/.test(value)) return null;
  const path = value.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return /\.pdf$/i.test(path) ? path : null;
}

type PreviewFrame = { postMessage(message: unknown, targetOrigin: string): void };
type PreviewFile = { data: ArrayBuffer; contentType?: string | null };

type PreviewBridgeOptions = {
  getFrame: () => PreviewFrame | null;
  requestAccess: (path: string) => Promise<boolean>;
  readPdf: (path: string) => Promise<PreviewFile>;
};

export function createPreviewPdfBridge({ getFrame, requestAccess, readPdf }: PreviewBridgeOptions) {
  let active = true;
  let pending = 0;
  const access = new Map<string, Promise<boolean>>();
  return {
    dispose() { active = false; access.clear(); },
    async onMessage(event: { source: unknown; data: unknown }) {
      const frame = getFrame();
      if (!active || !frame || event.source !== frame) return;
      const request = event.data;
      if (typeof request !== "object" || request === null || !("type" in request) || request.type !== "legalwork:pdf-request" || !("path" in request)) return;
      const path = sourcePdfPath(request.path);
      const id = "id" in request && typeof request.id === "string" ? request.id : request.path;
      const reply = (result: object) => {
        if (active && frame === getFrame()) frame.postMessage({ type: "legalwork:pdf-response", id, path: request.path, ...result }, "*");
      };
      if (!path) { reply({ ok: false, error: "Only relative source PDF paths are supported." }); return; }
      try {
        if (!access.has(path)) {
          if (pending >= 32) throw new Error("Too many pending source PDF requests.");
          pending++;
          access.set(path, requestAccess(path).finally(() => { pending--; }));
        }
        if ("waitForAccess" in request && request.waitForAccess === true) reply({ pending: true });
        const allowed = await access.get(path);
        if (!active || frame !== getFrame()) return;
        if (!allowed) { reply({ ok: false, error: "Access to this source PDF was declined." }); return; }
        const result = await readPdf(path);
        reply({ ok: true, contentType: "application/pdf", data: result.data });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : "Could not load the source PDF." });
      }
    },
  };
}
