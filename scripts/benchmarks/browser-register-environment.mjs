// Controller-only live website and file-byte observation. Nothing in this
// module, its configuration or its request traces is copied into the guest.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, posix, resolve } from "node:path";
import { startBrowserRegister, REGISTER_URL } from "./browser-register-fixture.mjs";
import { createSshBrowserDownloadCollector } from "./browser-download-collection.mjs";
import { privateWrite, readJson } from "./evidence.mjs";

export function verifyBrowserFixtureForward(config, command) {
  const { hostPort, guestPort, tunnelPID, cloud } = config;
  if (!Number.isSafeInteger(tunnelPID) || tunnelPID <= 0 || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535
    || guestPort !== Number(new URL(REGISTER_URL).port) || !cloud
    || [cloud.instance, cloud.project, cloud.zone].some(value => !/^[a-z0-9-]+$/.test(value ?? ""))) throw new Error("Explicit owned browser fixture transport required");
  const args = command.trim().split(/\s+/);
  const expected = `127.0.0.1:${guestPort}:127.0.0.1:${hostPort}`;
  const reverses = args.flatMap((value, index) => value === "-R" ? [args[index + 1]] : []);
  if (!args.some(value => /(?:^|\/)gcloud(?:\.py)?$/.test(value)) || !args.includes(`lwcontroller@${cloud.instance}`)
    || !args.includes(`--project=${cloud.project}`) || !args.includes(`--zone=${cloud.zone}`)
    || reverses.filter(value => value === expected).length !== 1
    || reverses.some(value => value !== expected && value?.startsWith(`127.0.0.1:${guestPort}:`))) throw new Error("Actual browser fixture tunnel differs from the reviewed cloud/loopback route");
  return { pid: tunnelPID, cloud, hostPort, guestPort, guestURL: REGISTER_URL, checkedAt: new Date().toISOString() };
}

export function verifyGuestFixtureProbe(records, nonce, observed, instanceID) {
  const matches = records.filter(record => record.headers?.["x-legalwork-fixture-probe"] === nonce);
  if (matches.length !== 1 || observed?.status !== 200 || matches[0].fixtureInstanceID !== instanceID
    || matches[0].path !== "/register" || matches[0].method !== "GET" || matches[0].status !== 200
    || matches[0].deliveryCompleted !== true || observed.bytes !== matches[0].responseBytes
    || observed.sha256 !== matches[0].responseSha256) throw new Error("The actual guest website route did not reach this arm's complete controller response");
  return { fixtureInstanceID: instanceID, requestID: matches[0].id, responseBytes: observed.bytes, responseSha256: observed.sha256 };
}

export function attachBrowserRegisterEnvironment({ environment, fixture, fixtureDirectory, verifyTransport, browserDownloads }) {
  if (!environment || !fixture?.instanceID || typeof fixture.snapshot !== "function"
    || typeof verifyTransport !== "function" || typeof browserDownloads !== "function") throw new Error("Live controller fixture, transport and actual byte collector required");
  return { ...environment, browserDownloads,
    async browserRegisterRequests({ task, stage, runId }) {
      if (task.browserFixture?.url !== REGISTER_URL || resolve(task.browserFixture.directory) !== fixtureDirectory
        || !["before", "admit", "after"].includes(stage)) throw new Error("Browser task differs from this arm's reviewed website fixture");
      await verifyTransport({ stage, runId });
      return { instanceID: fixture.instanceID, requests: await fixture.snapshot() };
    },
  };
}

export async function startBrowserRegisterEnvironment(environment, configPath, environmentConfigPath) {
  const config = await readJson(configPath);
  const packaged = await readJson(environmentConfigPath);
  if (config.kind !== "controller-browser-register" || !isAbsolute(config.fixtureDirectory ?? "")
    || !isAbsolute(config.evidence ?? "") || typeof environment?.files?.python !== "function"
    || ["instance", "instanceID", "project", "zone"].some(key => !config.cloud?.[key] || config.cloud[key] !== packaged.cloud?.[key])
    || config.workspaceDownloads !== posix.join(packaged.guest.workspace, "Downloads")) throw new Error("Private controller website configuration must match the actual packaged guest and project download directory");
  verifyBrowserFixtureForward(config, execFileSync("ps", ["-p", String(config.tunnelPID), "-o", "command="], { encoding: "utf8" }));
  // A new directory prevents accidentally combining the request journals of
  // the two engine arms or replacing an earlier attempt's transport evidence.
  await mkdir(config.evidence, { mode: 0o700 });
  const fixture = await startBrowserRegister({ directory: config.fixtureDirectory, traces: join(config.evidence, "requests"), port: config.hostPort });
  try {
    const downloads = createSshBrowserDownloadCollector({ files: environment.files, appUID: config.appUID,
      workspaceDownloads: config.workspaceDownloads, nativeTempRoot: config.nativeTempRoot });
    const verifyTransport = async ({ stage, runId }) => {
      const command = execFileSync("ps", ["-p", String(config.tunnelPID), "-o", "command="], { encoding: "utf8" });
      const tunnel = verifyBrowserFixtureForward(config, command);
      const evidence = { tunnel, fixtureInstanceID: fixture.instanceID, stage, runId, inferenceCalls: 0 };
      if (stage !== "after") {
        const nonce = randomUUID(), output = join(config.evidence, `guest-route-${nonce}.json`);
        await environment.files.python(String.raw`
import hashlib,json,pwd,sys,urllib.request
request=urllib.request.Request(sys.argv[1],headers={'x-legalwork-fixture-probe':sys.argv[2]})
with urllib.request.urlopen(request) as response:
 data=response.read()
 print(json.dumps({'status':response.status,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'appUID':pwd.getpwnam('legalwork').pw_uid}))
`, [REGISTER_URL, nonce], { output });
        const observed = await readJson(output);
        if (observed.appUID !== config.appUID) throw new Error("Configured browser byte collector UID differs from the actual ordinary app account");
        evidence.actualGuestRoute = verifyGuestFixtureProbe(await fixture.snapshot(), nonce, observed, fixture.instanceID);
      }
      await privateWrite(join(config.evidence, `transport-${stage}-${randomUUID()}.json`), evidence);
    };
    await privateWrite(join(config.evidence, "instance.json"), { instanceID: fixture.instanceID, hostURL: fixture.url,
      guestURL: REGISTER_URL, fixtureDirectory: config.fixtureDirectory, packagedEnvironmentConfigPath: environmentConfigPath, cloud: config.cloud, inferenceCalls: 0,
      originalDownloadBytes: "collected after task from exact service-returned file as ordinary app UID; no historical-byte claim" });
    return { environment: attachBrowserRegisterEnvironment({ environment, fixture, fixtureDirectory: resolve(config.fixtureDirectory), verifyTransport, browserDownloads: downloads }),
      close: () => fixture.close() };
  } catch (error) { await fixture.close(); throw error; }
}
