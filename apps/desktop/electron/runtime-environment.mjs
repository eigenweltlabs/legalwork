/** Child process isolation must never replace the desktop's OS home identity.
 * macOS Security.framework uses HOME to find the login keychain.
 */
export function applyEmbeddedServerEnvironment(target, childEnvironment) {
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (name.toUpperCase() === "HOME" || name.toUpperCase() === "USERPROFILE") continue;
    target[name] = value;
  }
}
