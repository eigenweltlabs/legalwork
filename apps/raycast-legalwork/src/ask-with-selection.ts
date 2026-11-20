import { showToast, Toast } from "@raycast/api";
import { launch, requirePairing, stageSelection } from "./legalwork";

/** The selection and command travel over the paired loopback connection. */
export default async function Command() {
  const pairing = await requirePairing();
  if (!pairing) return;
  try {
    const staged = await stageSelection(pairing);
    if (!staged) { await showToast({ style: Toast.Style.Failure, title: "Nothing selected", message: "Select text in the front app, then run this command." }); return; }
    await launch({ action: "ask", contextId: staged.id }, pairing);
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Could not stage the selection", message: error instanceof Error ? error.message : String(error) });
  }
}
