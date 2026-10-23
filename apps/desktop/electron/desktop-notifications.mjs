/** Electron's show() is asynchronous and can fail, particularly on macOS. */
export function showNativeNotification(notification, { onFailure = () => {}, logger = console, timeoutMs = 10_000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (shown, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      notification.off("show", shownEvent);
      notification.off("failed", failedEvent);
      notification.off("close", closedEvent);
      if (!shown) {
        onFailure();
        logger.warn("[desktop-notification] Delivery failed:", reason);
      }
      resolve(shown);
    };
    const shownEvent = () => finish(true);
    const failedEvent = (_event, error) => finish(false, error);
    const closedEvent = () => finish(false, "Closed before delivery");
    const timer = setTimeout(() => finish(false, "No delivery confirmation from the operating system"), timeoutMs);
    notification.once("show", shownEvent);
    notification.once("failed", failedEvent);
    notification.once("close", closedEvent);
    try { notification.show(); }
    catch (error) { finish(false, error instanceof Error ? error.message : String(error)); }
  });
}
/** Accept only bounded, embedded PNGs. Notification callers cannot read arbitrary files. */
export function notificationIcon(iconDataUrl, nativeImage) {
  if (typeof iconDataUrl !== "string" || iconDataUrl.length > 128 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(iconDataUrl)) return undefined;
  try {
    const image = nativeImage.createFromDataURL(iconDataUrl);
    return image.isEmpty() ? undefined : image.resize({ width: 128, height: 128 });
  } catch { return undefined; }
}
