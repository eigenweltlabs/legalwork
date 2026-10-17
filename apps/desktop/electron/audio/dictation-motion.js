// Ten-stroke motion measured from the supplied Wispr Flow recording, 1–2 s.
// Normalized profiles at 50 ms intervals; live microphone volume scales them.
const PROFILES = [
  [50,62,65,83,96,88,90,98,88,62],
  [52,62,75,75,100,88,85,88,83,62],
  [64,71,86,74,95,100,86,86,86,69],
  [60,71,80,80,78,100,80,78,71,58],
  [64,86,86,86,83,95,90,71,71,57],
  [61,88,94,92,84,74,100,74,61,53],
  [56,87,100,91,91,78,86,81,61,50],
  [53,81,100,98,89,82,74,84,58,42],
  [44,69,92,100,87,81,68,68,61,39],
  [38,65,86,100,95,83,71,57,67,38],
  [38,56,81,97,100,84,75,56,53,41],
  [39,50,74,92,100,87,76,58,44,42],
  [40,50,70,88,100,97,77,62,42,37],
  [40,50,60,80,95,100,83,70,50,30],
  [37,54,61,74,92,100,92,71,54,32],
  [36,63,63,73,88,100,99,82,63,36],
  [36,53,71,73,83,95,100,89,64,42],
  [39,49,79,74,80,95,100,93,71,44],
  [41,51,69,87,81,90,100,97,81,51],
  [49,61,64,98,87,89,98,100,87,57],
];

export function dictationMotionProfile(elapsedMs) {
  const position = (elapsedMs % 1000) / 50;
  const frame = Math.floor(position);
  const blend = position - frame;
  const next = PROFILES[(frame + 1) % PROFILES.length];
  return PROFILES[frame].map((height, index) => (height + (next[index] - height) * blend) / 100);
}
