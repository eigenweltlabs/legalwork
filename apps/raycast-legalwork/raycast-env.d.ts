/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `open-assistant` command */
  export type OpenAssistant = ExtensionPreferences & {}
  /** Preferences accessible in the `ask-with-selection` command */
  export type AskWithSelection = ExtensionPreferences & {}
  /** Preferences accessible in the `search` command */
  export type Search = ExtensionPreferences & {}
  /** Preferences accessible in the `quick-action` command */
  export type QuickAction = ExtensionPreferences & {}
  /** Preferences accessible in the `work` command */
  export type Work = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `open-assistant` command */
  export type OpenAssistant = {
  /** Question (optional) */
  "question": string
}
  /** Arguments passed to the `ask-with-selection` command */
  export type AskWithSelection = {}
  /** Arguments passed to the `search` command */
  export type Search = {}
  /** Arguments passed to the `quick-action` command */
  export type QuickAction = {}
  /** Arguments passed to the `work` command */
  export type Work = {}
}
