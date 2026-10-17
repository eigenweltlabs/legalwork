import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Chromium annotates Core Audio names with the transport type. @param {string} name */
function inputName(name) {
  return name.replace(/ \((Built-in|Virtual|Bluetooth|USB)\)$/i, "");
}

/** Preferences affect the next capture; an active microphone is never rerouted. */
export class DictationMicrophones {
  /** @param {{userDataDir: string, nativeInputs: () => Promise<import('@legalwork/types/audio').AudioDictationNativeInputs | null>, onChange: (state: import('@legalwork/types/audio').AudioDictationMicrophoneState) => void}} options */
  constructor(options) {
    this.path = path.join(options.userDataDir, "dictation-microphone.json");
    this.nativeInputs = options.nativeInputs;
    this.onChange = options.onChange;
    this.selection = "auto";
    /** @type {string | null} */
    this.selectedName = null;
    /** @type {string | null} */
    this.activeName = null;
    /** @type {import('@legalwork/types/audio').AudioDictationMicrophoneInput[]} */
    this.inputs = [];
    /** @type {import('@legalwork/types/audio').AudioDictationMicrophone[]} */
    this.devices = [];
    /** @type {string | null} */
    this.defaultDeviceId = null;
    this.version = 0;
    this.writes = Promise.resolve();
    this.initialized = null;
  }

  initialize() {
    if (!this.initialized) this.initialized = readFile(this.path, "utf8").then(text => {
      const value = JSON.parse(text);
      if (typeof value.selection === "string" && value.selection.length > 0) this.selection = value.selection;
      if (typeof value.selectedName === "string") this.selectedName = value.selectedName;
    }).catch(() => {});
    return this.initialized;
  }

  /** @returns {import('@legalwork/types/audio').AudioDictationMicrophoneState} */
  state() {
    const available = this.devices.filter(device => device.available);
    const system = available.find(device => device.id === this.defaultDeviceId);
    const automatic = system && !system.bluetooth ? system
      : available.find(device => device.builtIn) || available.find(device => !device.bluetooth) || system || available[0];
    const resolved = this.selection === "auto" ? automatic : this.selection === "default" ? system
      : available.find(device => device.id === this.selection);
    return {
      selection: this.selection,
      selectedName: this.selectedName,
      devices: this.devices,
      resolvedDeviceId: resolved?.id ?? null,
      activeName: this.activeName,
    };
  }

  /** @param {import('@legalwork/types/audio').AudioDictationMicrophoneInput[]} inputs @param {string | null} defaultDeviceId */
  async update(inputs, defaultDeviceId) {
    await this.initialize();
    const version = ++this.version;
    const info = await this.nativeInputs().catch(() => null);
    if (version !== this.version) return this.state();
    this.inputs = inputs.filter(input => input && typeof input.id === "string" && typeof input.name === "string"
      && input.id && input.id !== "default" && input.id !== "communications" && input.name).slice(0, 64);
    this.devices = this.inputs.map(input => {
      const native = info?.inputs.find(device => inputName(device.name) === inputName(input.name));
      return {
        ...input,
        bluetooth: native?.bluetooth === true,
        builtIn: native?.builtIn === true,
        // Browser enumeration is authoritative for connected inputs. Some
        // virtual drivers use different browser and Core Audio display names.
        available: !(info?.lidClosed && native?.builtIn),
      };
    });
    this.defaultDeviceId = info?.defaultInputName
      ? this.inputs.find(input => inputName(input.name) === inputName(info.defaultInputName))?.id ?? defaultDeviceId : defaultDeviceId;
    const result = this.state();
    this.onChange(result);
    return result;
  }

  async refresh() {
    await this.initialize();
    return this.update(this.inputs, this.defaultDeviceId);
  }

  /** @param {string} selection */
  async select(selection) {
    await this.initialize();
    const device = this.devices.find(device => device.id === selection && device.available);
    if (selection !== "auto" && selection !== "default" && !device) throw new Error("This microphone is unavailable. Choose another microphone.");
    this.selection = selection;
    this.selectedName = device?.name ?? null;
    const preferences = JSON.stringify({ selection, selectedName: this.selectedName });
    this.writes = this.writes.catch(() => {}).then(() => writeFile(this.path, preferences + "\n", "utf8"));
    await this.writes;
    const result = this.state();
    this.onChange(result);
    return result;
  }

  /** @param {string | null} name */
  setActive(name) {
    this.activeName = name;
    this.onChange(this.state());
  }
}
