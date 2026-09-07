// Run with playwright-cli run-code --filename=apps/app/scripts/voice-waveform-check.js
// on the local /design-system.html preview. Synthesized audio is never played.
async (page) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/design-system\.html/.test(page.url())) {
    throw new Error("Open the local design-system preview first.");
  }
  const preview = page.getByTestId("voice-waveform-preview");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await preview.scrollIntoViewIfNeeded();
  await preview.getByRole("button", { name: "speaking", exact: true }).click();
  await page.evaluate(async () => {
    const { createVoiceAudioMeter } = await import("/src/react-app/domains/session/voice/voice-audio-meter.ts");
    const synth = new AudioContext();
    const oscillator = synth.createOscillator();
    const gain = synth.createGain();
    const destination = synth.createMediaStreamDestination();
    oscillator.frequency.value = 220;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    await synth.resume();
    const meter = createVoiceAudioMeter();
    if (!meter) throw new Error("Audio metering is unavailable");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    try {
      meter.setInputStream(destination.stream);
      await settle();
      if (meter.sample().level !== 0) throw new Error("Silence should not animate the waveform");
      gain.gain.value = 0.015;
      await settle();
      const quiet = meter.sample().level;
      gain.gain.value = 0.18;
      await settle();
      const loud = meter.sample().level;
      if (!(quiet > 0.03 && loud > 0.5 && loud > quiet * 2)) throw new Error("Speech volume is not reflected in the meter");
      if (!(meter.sample().bands[1] > meter.sample().bands[5])) throw new Error("Frequency bands do not match the source");
      if (meter.sample(false, true).level !== 0) throw new Error("A muted microphone is still measured");
      meter.setOutputStream(destination.stream);
      await settle();
      if (meter.sample(false, true).level < 0.5) throw new Error("AI output is not measured");
      if (meter.sample(false, false).level !== 0) throw new Error("Muted audio is still measured");
      meter.dispose();
      if (meter.sample().level !== 0) throw new Error("A disposed meter is still active");
      if (destination.stream.getAudioTracks()[0].readyState !== "live") throw new Error("Meter cleanup stopped the call's audio track");
    } finally {
      meter.dispose();
      oscillator.stop();
      destination.stream.getTracks().forEach((track) => track.stop());
      await synth.close();
    }
  });

  const canvas = preview.locator("canvas");
  const height = () => canvas.evaluate((element) => {
    const pixels = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    let min = element.height, max = 0;
    for (let y = 0; y < element.height; y++) for (let x = 0; x < element.width; x++) {
      if (pixels[(y * element.width + x) * 4 + 3] > 30) { min = Math.min(min, y); max = Math.max(max, y); }
    }
    return max - min;
  });
  await preview.getByLabel("Simulated audio volume").fill("0");
  await page.waitForTimeout(700);
  const quietHeight = await height();
  await preview.getByLabel("Simulated audio volume").fill("1");
  let loudHeight = 0;
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(180); loudHeight = Math.max(loudHeight, await height()); }
  if (loudHeight < quietHeight * 2) throw new Error("The drawn waveform does not respond to volume");
  for (const status of ["connecting", "listening", "thinking", "tool use", "waiting approval", "speaking", "error"]) {
    await preview.getByRole("button", { name: status, exact: true }).click();
    await preview.getByRole("img", { name: `Voice status: ${status}`, exact: true }).waitFor();
  }
  await preview.getByRole("button", { name: "speaking", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  const before = await canvas.evaluate((element) => element.toDataURL());
  await page.waitForTimeout(300);
  const after = await canvas.evaluate((element) => element.toDataURL());
  if (before !== after) throw new Error("The waveform moves with reduced motion enabled");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await preview.screenshot({ path: "output/playwright/voice-waveform-light.png" });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); document.documentElement.dataset.theme = "dark"; });
  await page.waitForTimeout(300);
  await preview.screenshot({ path: "output/playwright/voice-waveform-dark.png" });
  await page.evaluate(() => { document.documentElement.classList.remove("dark"); delete document.documentElement.dataset.theme; });
}
