import { showToast, Toast } from "@raycast/api";
import { launch, requirePairing, stageSelection } from "./legalwork";

/** The selection travels over the paired loopback connection as a one-time staged context; only its ID enters the URL. */
export default async function Command() {
  const pairing = await requirePairing();
  if (!pairing) return;
  try {
    const staged = await stageSelection(pairing);
    if (!staged) { await showToast({ style: Toast.Style.Failure, title: "Nothing selected", message: "Select text in the front app, then run this command." }); return; }
    await launch("ask", { context: staged.id });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Could not stage the selection", message: error instanceof Error ? error.message : String(error) });
  }
}
