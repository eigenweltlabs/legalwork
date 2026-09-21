# Verify a download

Download the installer and `SHA256SUMS` from the **same version** on the
[releases page](https://github.com/eigenweltlabs/legalwork/releases).
Compare the installer's SHA256 with the entry for its exact filename in the list.
Checksums are generated from the final release files, after any platform signing.

On macOS, run `shasum -a 256 "PATH_TO_INSTALLER"`. On Linux, use
`sha256sum "PATH_TO_INSTALLER"`. On Windows PowerShell, use
`Get-FileHash "PATH_TO_INSTALLER" -Algorithm SHA256`. Replace `PATH_TO_INSTALLER`
with your downloaded file's path.

The checksum list helps verify that a download matches the published artifact.
It is not separately signed. On macOS, the app also has a Developer ID signature
and notarization, which Gatekeeper checks when you open it. To check an installed
copy, run:

```sh
codesign --verify --deep --strict /Applications/LegalWork.app
spctl --assess --type execute --verbose=2 /Applications/LegalWork.app
codesign --display --verbose=2 /Applications/LegalWork.app
```

The signing Team ID is `9VTQ834B95` (Christian-Hauke Poensgen).
