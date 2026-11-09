# Windows small OCR runtime verification

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

The broader packaging tests require the generated browser controller first:
`node apps/desktop/scripts/build-browser-controller.mjs`.

## Limits and maintenance

Native execution was verified on Windows x64. ARM64 source extraction, exact
hashes, architecture-specific copying, and package validation were tested; no
native ARM64 Windows host was available. A complete signed Windows installer
and GUI model-download flow were not rebuilt for this change. This is headless
native-worker evidence; no GUI video was recorded.

The DLLs remain unmodified Microsoft redistributable files, subject to the
[Visual Studio redistribution terms](https://learn.microsoft.com/visualstudio/releases/2022/redistribution).
App-local runtime updates must be delivered with LegalWork updates. Update the
archive URL, archive hash, directory version, and all DLL hashes together, and
repeat the clean-machine smoke test when changing the pin.

This change fixes packaged small/local OCR dependencies. It does not enable the
quality model on Windows or reopen the closed quality-model PR #191.
