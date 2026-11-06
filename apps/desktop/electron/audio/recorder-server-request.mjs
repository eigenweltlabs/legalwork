/** Only messages authored here are safe to display as recorder request errors. */
export class RecorderRequestError extends Error {}

const DISCONNECTED = "LegalWork is disconnected. Open Settings to reconnect, then try again. Your transcript is saved.";

export async function requestRecorderServer(info, route, body, signal = AbortSignal.timeout(10_000)) {
  if (!info?.running || !info.baseUrl || (!info.ownerToken && !info.clientToken)) {
    throw new RecorderRequestError(DISCONNECTED);
  }
  let response;
  try {
    response = await fetch(`${info.baseUrl}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${info.ownerToken || info.clientToken}`,
        ...(info.hostToken ? { "X-LegalWork-Host-Token": info.hostToken } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal, redirect: "error",
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new RecorderRequestError(DISCONNECTED, { cause: error });
  }
  if (!response.ok) {
    throw new RecorderRequestError(response.status === 401 || response.status === 403
      ? "Cloud access was denied. Sign in and check your organisation's model settings. Your transcript is saved."
      : "The cloud request failed. Try again shortly. Your transcript is saved.");
  }
  return response.json();
}
