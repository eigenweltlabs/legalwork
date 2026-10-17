import { audioSystemDictationMicrophonesGet, audioSystemDictationMicrophonesUpdate } from "@/app/lib/desktop";

/** Enumerating inputs does not open the microphone or disturb Bluetooth playback. */
export async function refreshDictationMicrophones() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return audioSystemDictationMicrophonesGet();
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(device => device.kind === "audioinput" && device.label
    && device.deviceId !== "default" && device.deviceId !== "communications");
  const defaultInput = devices.find(device => device.kind === "audioinput" && device.deviceId === "default");
  const system = inputs.find(device => defaultInput && device.groupId === defaultInput.groupId) ?? inputs[0];
  return audioSystemDictationMicrophonesUpdate(
    inputs.map(device => ({ id: device.deviceId, name: device.label })), system?.deviceId ?? null,
  );
}
