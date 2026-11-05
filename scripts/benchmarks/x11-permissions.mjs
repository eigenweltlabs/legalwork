// Host-only normal UI input, never copied into the guest or exposed as a tool.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { privateProcess, shellQuote } from "./remote-files.mjs";
import { privateWrite, sha256 } from "./evidence.mjs";
import { assertTaskSession } from "./admission-invariants.mjs";
import { externalDirectoryDecision, exactRejectedReply } from "./permission-policy.mjs";
import { combinedDenyTarget, DENY_IMAGE_PREPROCESS } from "./deny-ocr.mjs";

const x11 = String.raw`
import os,pathlib,ctypes,time,pwd,sys,json
from PIL import ImageGrab
action,runtime,profile,target,x,y=sys.argv[1:];matches=[];user=pwd.getpwnam('legalwork')
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if p.stat().st_uid!=user.pw_uid or os.readlink(p/'exe')!=runtime+'/legalwork' or b'--type=' in (p/'cmdline').read_bytes():continue
  env=dict(v.split('=',1) for v in (p/'environ').read_bytes().decode().split('\0') if '=' in v)
  if env.get('LEGALWORK_ELECTRON_USERDATA')==profile:matches.append(env)
 except(FileNotFoundError,ProcessLookupError,PermissionError):continue
if len(matches)!=1:raise RuntimeError('Exactly one owned profile main X display is required')
env=matches[0]
for k in ['DISPLAY','XAUTHORITY']:os.environ[k]=env[k]
if action=='click':
 x=float(x);y=float(y)
 lib=ctypes.CDLL('libX11.so.6');test=ctypes.CDLL('libXtst.so.6');lib.XOpenDisplay.argtypes=[ctypes.c_char_p];lib.XOpenDisplay.restype=ctypes.c_void_p;lib.XFlush.argtypes=[ctypes.c_void_p];lib.XCloseDisplay.argtypes=[ctypes.c_void_p]
 display=lib.XOpenDisplay(env['DISPLAY'].encode())
 if not display:raise RuntimeError('Owned X display unavailable')
 test.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong];test.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
 test.XTestFakeMotionEvent(display,0,int(x),int(y),0);test.XTestFakeButtonEvent(display,1,1,0);test.XTestFakeButtonEvent(display,1,0,0);lib.XFlush(display);lib.XCloseDisplay(display);time.sleep(0.2)
image=ImageGrab.grab(xdisplay=env['DISPLAY']);image.save(target);owner=pwd.getpwnam('lwcontroller');os.chown(target,owner.pw_uid,owner.pw_gid);os.chmod(target,0o600)
print(json.dumps({'action':action,'width':image.width,'height':image.height,'profile':profile,'x':x if action=='click' else None,'y':y if action=='click' else None}))
`;

export async function declineThroughVisibleUI({ config, files, driver, protocol, events, request, ownedSessionIDs, rootSessionID, taskDirectory, evidence }) {
  const decision = externalDirectoryDecision(request, { ownedSessionIDs, taskDirectory });
  if (decision.decision !== "reject") throw new Error(`Permission policy held: ${decision.reason}`);
  const settings = config.permissionUi;
  if (settings?.method !== "x11-visible-deny-ocr" || !settings.tesseract || !settings.imagePython || settings.imageScale !== 4 || !(settings.pollIntervalMs > 0)) throw new Error("Explicit controller-only X11 permission UI settings required");
  const started = performance.now();
  const observedAt = new Date().toISOString();
  const operation = join(evidence, `permission-${sha256(request.id)}-${randomUUID()}`);
  await mkdir(operation, { recursive: true, mode: 0o700 });
  async function unchangedPending() {
    const pending = await protocol.interactions();
    if (pending.permissions.length !== 1 || pending.forms.length || pending.host.length || pending.permissions[0].id !== request.id || pending.permissions[0].sessionID !== request.sessionID || JSON.stringify(pending.permissions[0]) !== JSON.stringify(request)) throw new Error("Pending UI source changed or became ambiguous; no Deny click permitted");
    assertTaskSession(await driver.snapshot(), rootSessionID, "before exact visible permission Deny");
  }
  async function screenshot(action, target) {
    const id = randomUUID();
    const guest = `/home/lwcontroller/permission-${id}.png`;
    const path = join(operation, `${action}-${id}.png`);
    const metadataPath = join(operation, `${action}-${id}.json`);
    await files.ssh(["sudo", "-n", "/opt/legalwork-tools/bin/python", "-c", x11, action, config.guest.runtime, config.guest.profile, guest, String(target?.x ?? ""), String(target?.y ?? "")].map(shellQuote).join(" "), { output: metadataPath });
    await privateProcess("gcloud", ["compute", "scp", `lwcontroller@${config.cloud.instance}:${guest}`, path, `--project=${config.cloud.project}`, `--zone=${config.cloud.zone}`, "--tunnel-through-iap", `--ssh-key-file=${config.keyPath}`, "--quiet"], { evidence: join(operation, `copy-${id}`) });
    return { path, sha256: sha256(await readFile(path)), ...JSON.parse(await readFile(metadataPath, "utf8")) };
  }
  await driver.focusChat(rootSessionID);
  await unchangedPending();
  const before = await screenshot("capture");
  const ocr = join(operation, "deny-ocr");
  const preprocessed=join(operation,"ocr-grayscale-autocontrast-4x.png");
  const recognitionStarted = performance.now(), passes = [], passEvidence = [];
  async function recognize(method, label, imagePath, ocrPath) {
    const passStarted = performance.now();
    await privateProcess(settings.imagePython,["-c",DENY_IMAGE_PREPROCESS,before.path,imagePath,method],{evidence:join(operation,label+"-preprocess")});
    await privateProcess(settings.tesseract, [imagePath, ocrPath, "--psm", "11", "tsv"], { evidence: join(operation, label) });
    const tsv = await readFile(`${ocrPath}.tsv`, "utf8");
    passes.push({ method, tsv });
    passEvidence.push({ fullImage:true, imagePath, imageSha256:sha256(await readFile(imagePath)),ocrPath:ocrPath+".tsv",ocrSha256:sha256(tsv),scale:4,method,elapsedMs:performance.now()-passStarted });
  }
  const dimensions = { minimumConfidence: settings.minimumConfidence, width: before.width, height: before.height, scale: settings.imageScale };
  await recognize("grayscale","ocr",preprocessed,ocr);
  await recognize("red-ink","ocr-red-ink",join(operation,"ocr-red-ink-autocontrast-4x.png"),join(operation,"deny-ocr-red-ink"));
  const recognition = combinedDenyTarget(passes, dimensions), recognitionMode = "full-frame-grayscale-plus-full-frame-red-ink";
  const target = recognition.target;
  await privateWrite(join(operation, "before-click.json"), { request, decision, rootSessionID, ownedSessionIDs, before, preprocessed:{path:preprocessed,sha256:sha256(await readFile(preprocessed)),method:"controller-only-grayscale-autocontrast-lanczos-4x"},ocrPath: `${ocr}.tsv`, ocrSha256: passEvidence[0].ocrSha256, target, recognition:{...recognition,mode:recognitionMode,passes:passEvidence,elapsedMs:performance.now()-recognitionStarted},visualSafety: { minimumConfidence: settings.minimumConfidence, reason: "Only prevents an uncertain or ambiguous UI click; does not cap agent tasks, tools, outputs or permission count." } });
  await unchangedPending();
  const after = await screenshot("click", target);
  let reply;
  do {
    events.check();
    reply = exactRejectedReply(events.permissionReplies(), request);
    const pending = await protocol.interactions();
    if (reply && !pending.permissions.some(item => item.id === request.id && item.sessionID === request.sessionID)) break;
    await delay(settings.pollIntervalMs);
  } while (true);
  const result = { scenario: "scripted-external-directory-decline", request, decision: "reject", decisionSource: "normal-visible-Deny-button-X11", observedAt, repliedAt: new Date().toISOString(), requestToReplyObservedMs: performance.now() - started, reply, before, after, target, injectedMessages: 0, persistedGrants: 0, permissionWaitDeadlineMs: null, evidence: operation };
  await privateWrite(join(operation, "ui-rejection-receipt.json"), result);
  return result;
}
