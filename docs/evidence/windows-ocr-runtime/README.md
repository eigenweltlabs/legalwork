# Windows OCR runtime verification

On 9 November 2026, the current dev small OCR worker was tested
on Windows Server 2022 Desktop Experience x64 with no system VC++ runtime.
Its model files were intact, but loading onnxruntime-node 1.23.2 failed.

The test copied LegalWork 0.3.11's shipped Node executable and ONNX package
into a private staging directory, and added the current dev worker and sample
from commit 8bd9e3d14. The worker read the unchanged installed model files. Every worker process used an empty PATH.
The four checksum-pinned retail Microsoft DLLs from
`apps/desktop/build/windows-vc-runtime.json` were the only variable.

| Run | Result |
| --- | --- |
| Native addon without the DLLs | Exit 1, ERR_DLOPEN_FAILED |
| DLLs alongside onnxruntime_binding.node / onnxruntime.dll | Exit 0, three expected text regions, 1.76 seconds |
| Same DLLs removed | Exit 1, ERR_DLOPEN_FAILED |

The production packaging guard accepted the staged DLLs. All four retained
valid Microsoft Authenticode signatures and reported version 14.44.35211.0.
The staging files were removed; the installed app, model files, and system
runtime were unchanged. See [machine-readable results](windows-native-ocr.json).

The DLLs must be alongside ONNX's native addon. A preliminary test placing them
only beside node.exe failed because that location was not sufficient for this
addon's Windows DLL loading path. The final package uses ONNX's native directory
and does not modify the machine PATH or require elevation.

| Target | Installed DLL bytes | Gzip payload estimate |
| --- | ---: | ---: |
| Windows x64 | 768,016 | 287,003 |
| Windows ARM64 | 1,675,480 | 483,331 |

Only the target architecture ships. These compressed figures are estimates for
the DLLs together; the final NSIS installer's incremental size can differ.
The build downloads the larger VSIX source archive but does not ship it.

## Optional quality-model downloads

The optional Windows x64 runtime is llama.cpp `b11234`'s official Vulkan ZIP,
including its CPU backends. It is downloaded only by an explicit **Download model**
action, together with the two pinned PaddleOCR-VL-1.6 GGUF files. Startup downloads
only the small text model and shared layout model. Installing quality OCR preserves
the selected default. The same app-local CRT files are copied beside
`llama-server.exe`; launching it refreshes changed files after an app update and
leaves identical files untouched.

| Optional Windows x64 asset | Download bytes |
| --- | ---: |
| Main GGUF | 935,769,056 |
| Vision projector GGUF | 881,770,560 |
| llama.cpp ZIP | 33,058,657 |
| Total, before missing shared assets | 1,850,598,273 |

The ZIP expands to 94,445,341 bytes before the app-local CRT copy. Completed,
verified assets are reused; cancellation removes the current partial download.
Settings show the maximum download size and current-file transferred bytes.

The current branch's `OcrManager`/`OcrRuntime` ran on the same clean Windows x64
VM, using bundled Node 22.23.4 and the staged packaged native libraries. The final
run began with the verified runtime/main GGUF and shared models cached. It
cancelled the projector download after 158,053 bytes, removed its partial file,
made zero download requests after restart, and completed an explicit retry without
re-downloading the cached assets. Setup preserved the fast default. A separate
quality recognition run read all three English/German sample lines in 35.91
seconds on the CPU-only 4-vCPU/16-GB VM. Selecting quality, hiding a required
weight, and restarting still triggered zero downloads. With the weight restored
and the download transport forced offline, **Test sample** passed again. All four
system CRT DLLs remained absent; all four were present beside `llama-server.exe`.
No owned native processes remained after completion. See the
[machine-readable quality results](windows-quality-opt-in.json). These sample
checks establish runtime behavior, not comparative recognition accuracy.

The real Settings component was also exercised in an isolated browser fixture
with synthetic responses: opening Settings started no install, Download model
showed progress, Cancel stopped setup, retry was available, completion preserved
the fast default, and only **Use as default** selected quality. The browser console
had no errors. This UI check used a mocked client; native-model execution is
reported separately. No screenshots or recordings are shared.

## Reproduction

On the Windows build machine, install workspace dependencies with pnpm, then:

```powershell
node apps/desktop/scripts/prepare-node-runtime.mjs
# Use a provisioned OCR root containing models/pp-ocrv6-small.json and its assets.
$env:LEGALWORK_OCR_NATIVE_SMOKE_ROOT = 'C:\path\to\ocr'
Set-Location apps/desktop
node scripts/smoke-ocr-package.mjs
```

The smoke script builds an isolated ASAR/unpacked layout using the real builder
rules, uses the bundled Node executable and an empty PATH, and recognizes the
sample. Run on a clean VM without system VC++ DLLs to verify app-local loading.

Automated regression checks:

```sh
node --test apps/desktop/electron/packaged-*.test.mjs scripts/gen-core-skills.test.mjs
pnpm docs:check
```

To check the optional download in a Windows desktop build from this branch:

1. Build the Windows app with `pnpm --filter @legalwork/desktop package:electron:dir` on Windows, using the repository's packaging prerequisites.
2. Launch the packaged app on an isolated profile on a VM without the four system CRT DLLs.
3. In **Settings > AI Providers > Document recognition providers (OCR)**, confirm the quality model shows about 1.85 GB and no quality download has started.
4. Choose **Download model**, verify byte progress, cancel during a GGUF transfer, then restart the app. No quality transfer should restart automatically.
5. Retry **Download model**, wait for setup verification, and choose **Test sample**. Confirm the default remains fast until **Use as default** is chosen.
6. Restart with network access disabled and run **Test sample** again. Quit and confirm the owned `llama-server.exe` process exits.

The broader packaging tests require the generated browser controller first:
`node apps/desktop/scripts/build-browser-controller.mjs`.

## Limits and maintenance

Native execution was verified on Windows Server 2022 x64. ARM64 CRT source
extraction, exact hashes, architecture-specific copying, and package validation
were tested; no native ARM64 Windows host was available. The quality model is
unsupported on Windows ARM64. A complete signed Windows installer, Windows 11,
and real GPU acceleration were not tested for this change. The browser fixture
verifies the controls; it does not replace an installed desktop end-to-end test.

The DLLs remain unmodified Microsoft redistributable files, subject to the
[Visual Studio redistribution terms](https://learn.microsoft.com/visualstudio/releases/2022/redistribution).
App-local runtime updates must be delivered with LegalWork updates. Update the
archive URL, archive hash, directory version, and all DLL hashes together, and
repeat the clean-machine smoke test when changing the pin.

This change also enables the optional quality model on Windows x64. Closed
quality-model PR #191 remains closed; implementation is in PR #420.
