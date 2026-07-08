; LegalWork NSIS customizations (electron-builder `nsis.include`).
;
; Uninstall cleanup for the Office add-in: the settings tab registers
; per-app manifests under HKCU\...\WEF\Developer and trusts a localhost-
; constrained CA in the CurrentUser Root store. Without this cleanup an
; uninstalled LegalWork would leave Word/Excel/PowerPoint pointing at a
; manifest that no longer resolves, plus a stray trusted CA.
;
; Everything is best-effort (the user may never have installed the add-in),
; and skipped during in-place updates so auto-updates never touch the
; registrations or prompt the user.
;
; Manifest ids: keep in sync with WORD_ADDIN_MANIFEST_IDS in
; apps/server/src/word-addin.ts and apps/desktop/electron/office-addin-platform.mjs.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing LegalWork Office add-in registrations..."
    ; Word
    ExecWait 'reg delete "HKCU\Software\Microsoft\Office\16.0\WEF\Developer" /v "fdea378d-ff62-4a4f-af08-d1622c083957" /f'
    ; Excel
    ExecWait 'reg delete "HKCU\Software\Microsoft\Office\16.0\WEF\Developer" /v "65facd67-9deb-4356-8072-e2cc6e36d9fe" /f'
    ; PowerPoint
    ExecWait 'reg delete "HKCU\Software\Microsoft\Office\16.0\WEF\Developer" /v "db1cc438-a239-4b01-b732-2ff838ecca38" /f'
    ; Remove the localhost-constrained CA from the user trust store. When the
    ; CA is present Windows shows one confirmation dialog; denying it keeps
    ; the CA (the user's call). When absent certutil fails fast and silently.
    ; Two passes sweep a stale duplicate from older installs.
    ExecWait 'certutil -user -delstore Root "LegalWork Local CA"'
    ExecWait 'certutil -user -delstore Root "LegalWork Local CA"'
  ${endIf}
!macroend
