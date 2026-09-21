/** Keep Chromium's application-wide debugger disabled in releases. */
export function configureRemoteDebugging(app, env = process.env) {
  // Also cover switches supplied on the command line or through extra args.
  for (const name of ["remote-debugging-port", "remote-debugging-address", "remote-debugging-pipe"]) {
    app.commandLine.removeSwitch(name);
  }
  const port = Number(env.LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim());
  if (app.isPackaged || !Number.isInteger(port) || port <= 0 || port > 65535) return;
  app.commandLine.appendSwitch("remote-debugging-port", String(port));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
