/** This dialog authorizes a single report. A close, timeout or interrupted chat cancels it. */
export async function confirmSupportTicket({ window, showMessageBox, locale, report, signal }) {
  if (signal.aborted || !window || window.isDestroyed()) return "cancel";
  const german = /^de(?:[-_]|$)/i.test(locale);
  const options = german ? {
    title: "LegalWork-Support",
    message: "Support-Ticket an Eigenwelt Labs senden?",
    detail: `Ihr Konto (${report.email}) und Ihre Benutzer-ID werden mitgesendet. Möchten Sie die Support-Protokolle aus Einstellungen > Updates anhängen? Sie können Dateipfade und vertrauliche Inhalte aus Fehlermeldungen enthalten.\n\n${report.description}`,
    buttons: ["Abbrechen", "Ohne Protokolle senden", "Mit Protokollen senden"],
  } : {
    title: "LegalWork Support",
    message: "Send this support ticket to Eigenwelt Labs?",
    detail: `Your account email (${report.email}) and user ID are included. Would you like to attach the Support Logs from Settings > Updates? They may include file paths and confidential details from error messages.\n\n${report.description}`,
    buttons: ["Cancel", "Send without logs", "Send with logs"],
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  window.once("closed", abort);
  try {
    const choice = await showMessageBox(window, {
      ...options, type: "question", defaultId: 0, cancelId: 0, noLink: true,
      signal: AbortSignal.any([signal, controller.signal]),
    });
    if (signal.aborted || controller.signal.aborted) return "cancel";
    if (choice.response === 2) return "with_logs";
    if (choice.response === 1) return "without_logs";
    return "cancel";
  } finally {
    window.removeListener("closed", abort);
  }
}
