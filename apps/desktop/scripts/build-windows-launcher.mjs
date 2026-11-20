import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const frameworkName = process.arch === "ia32" ? "Framework" : "Framework64";
  const framework = path.join(process.env.SystemRoot, "Microsoft.NET", frameworkName, "v4.0.30319");
  const output = path.join(root, "resources/helpers/LegalWorkLauncherOrigin.exe");
  mkdirSync(path.dirname(output), { recursive: true });
  const references = ["WPF/UIAutomationClient.dll", "WPF/UIAutomationTypes.dll", "WPF/WindowsBase.dll", "System.Web.Extensions.dll"];
  execFileSync(path.join(framework, "csc.exe"), [
    "/nologo", "/optimize+", "/target:exe", "/platform:anycpu", "/out:" + output,
    ...references.map(file => "/reference:" + path.join(framework, file)),
    path.join(root, "native-launcher/windows/LauncherOrigin.cs"),
  ], { stdio: "inherit" });
}
