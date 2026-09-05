# Audio-reactive voice waveform

Voice mode uses a flat ribbon of fine cyan, blue, and violet contours. Its height follows audio volume and its contours respond to six frequency bands, with quick attack and a softer release. Quiet audio settles to a thin ribbon; approval and error states use amber and rose accents.

The meter reads the call's existing microphone and remote audio streams locally. Each mute control gates its corresponding visual input. It adds no recording, upload, or speaker connection, and disposing the meter leaves the call-owned audio tracks intact. Drawing runs outside React's render loop, pauses offscreen, and becomes static when reduced motion is enabled.

[Nine-second preview recording](voice-waveform-demo.mp4) · [Light theme](voice-waveform-light.png) · [Dark theme](voice-waveform-dark.png)

The visual preview uses an explicitly labeled simulated volume control. The browser regression separately exercises the production audio meter with a silent Web Audio oscillator: silence, quiet/loud audio, frequency bands, both mute gates, remote audio input, and cleanup. It also checks rendered wave height, all seven status labels, and switching reduced motion on while mounted.

## Validation

- `pnpm typecheck` — passed.
- `pnpm build:ui` — passed with existing build warnings.
- `pnpm --filter @legalwork/app exec bun test tests/voice-activity.test.ts tests/voice-completion-delivery.test.ts` — 8 passed, 11 assertions.
- Browser regression below — passed; no console errors. Canvas readback and reduced-motion notices come from the verification flow.
- `git diff --check` — passed.

Start `PORT=5174 pnpm dev:ui` from the repository root, then run:

```sh
mkdir -p output/playwright
pnpm dlx @playwright/cli --session voice-waveform open http://localhost:5174/design-system.html#assets
pnpm dlx @playwright/cli --session voice-waveform run-code --filename=apps/app/scripts/voice-waveform-check.js
pnpm dlx @playwright/cli --session voice-waveform close
```

For the desktop, run `LEGALWORK_WORD_ADDIN=0 pnpm dev`, open voice mode, and speak at different volumes. Verify microphone mute, AI playback, and speaker mute. The automated checks did not place a live provider call.
