/** Export locally through a native save dialog; the renderer never chooses a path. */
export async function saveErrorDetails(contents, chooseDestination, write) {
  if (typeof contents !== "string" || contents.length > 32_000_000) throw new Error("Invalid error details");
  const event = JSON.parse(contents);
  if (event?.event !== "$exception" || typeof event.uuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.uuid)) {
    throw new Error("Invalid error event");
  }
  const { canceled, filePath } = await chooseDestination({
    defaultPath: `legalwork-error-${event.uuid}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return false;
  await write(filePath, contents, { encoding: "utf8", mode: 0o600 });
  return true;
}
