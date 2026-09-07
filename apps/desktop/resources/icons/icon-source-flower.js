// Source sketch for icon.png — rendered with eigenwelt/code-paint-generator
// (p5.brush, 600x600 WEBGL) at ART_SEED=600, then cropped to 90% and laid on
// the 824px rounded plate inset at (100,100) of a 1024 canvas.
//
//   npx tsx src/cli.ts render --sketch icon-source-flower.js --seed 600 --size 1200

function setup() {
  createCanvas(ART_SIZE, ART_SIZE, WEBGL);
  angleMode(DEGREES);
  randomSeed(ART_SEED);
  noiseSeed(ART_SEED);
  brush.scaleBrushes(3);
}

// LegalWork icon palette
// paper  #FEFEFE
// blue   #2352DE
// purple #8669B9
// ink    #0E0A07

function petal(cx, cy, a, len, spread, curve) {
  const half = spread * 0.5;
  const inner = random(20, 28);
  const pts = [
    [a - half * 0.26, inner],
    [a - half * 0.90 + random(-2, 2), len * random(0.48, 0.58)],
    [a - half * 0.60 + random(-3, 2), len * random(0.82, 0.93)],
    [a + random(-3, 3), len],
    [a + half * 0.60 + random(-2, 3), len * random(0.82, 0.94)],
    [a + half * 0.90 + random(-2, 2), len * random(0.48, 0.59)],
    [a + half * 0.26, inner]
  ];
  brush.beginShape(curve);
  for (let j = 0; j < pts.length; j++) {
    brush.vertex(cx + cos(pts[j][0]) * pts[j][1], cy + sin(pts[j][0]) * pts[j][1]);
  }
  brush.endShape(CLOSE);
}

function draw() {
  translate(-width / 2, -height / 2);
  background("#FEFEFE");

  const designs = [
    {
      // 0 — anemone, eight blue petals over a purple wash
      cx: 300, cy: 298,
      angles: [188, 232, 276, 320, 4, 48, 92, 140],
      lengths: [222, 236, 228, 240, 224, 238, 226, 234],
      spreads: [50, 46, 48, 45, 49, 47, 50, 46],
      petals: ["#2352DE", "#3a63e2", "#2450dd", "#4a72e8", "#2352DE", "#3f68e4", "#2a57e0", "#456ee6"],
      petalAlpha: 176,
      inner: "#8669B9", innerAlpha: 92,
      center: "#0E0A07", centerRadius: [46, 60],
      vein: "rgba(35,82,222,0.30)",
      pollen: "#8669B9", pollenRadius: [66, 84],
      centerShape: "blob"
    },
    {
      // 1 — six petals, blue and purple alternating
      cx: 302, cy: 300,
      angles: [210, 270, 330, 30, 90, 150],
      lengths: [242, 228, 246, 232, 244, 230],
      spreads: [64, 60, 66, 61, 65, 60],
      petals: ["#2352DE", "#8669B9", "#2352DE", "#8669B9", "#2b58e0", "#9074c2"],
      petalAlpha: 182,
      inner: "#2352DE", innerAlpha: 78,
      center: "#0E0A07", centerRadius: [44, 57],
      vein: "rgba(14,10,7,0.26)",
      pollen: "#8669B9", pollenRadius: [64, 82],
      centerShape: "blob"
    },
    {
      // 2 — dense rosette, twelve narrow petals
      cx: 300, cy: 302,
      angles: [180, 210, 240, 270, 300, 330, 0, 30, 60, 90, 120, 150],
      lengths: [216, 232, 220, 236, 218, 230, 222, 238, 216, 232, 224, 234],
      spreads: [30, 33, 30, 34, 31, 33, 30, 34, 31, 33, 30, 34],
      petals: ["#8669B9", "#2352DE", "#9074c2", "#3a63e2", "#8669B9", "#2352DE"],
      petalAlpha: 172,
      inner: "#2352DE", innerAlpha: 84,
      center: "#0E0A07", centerRadius: [40, 52],
      vein: "rgba(70,54,110,0.30)",
      pollen: "#2352DE", pollenRadius: [58, 74],
      centerShape: "blob"
    },
    {
      // 3 — cornflower, five broad purple petals with blue veining
      cx: 298, cy: 300,
      angles: [198, 270, 342, 54, 126],
      lengths: [246, 230, 250, 234, 244],
      spreads: [72, 68, 74, 69, 71],
      petals: ["#8669B9", "#7d5fb3", "#7256a6", "#8669B9", "#7a5cae"],
      petalAlpha: 208,
      inner: "#2352DE", innerAlpha: 80,
      center: "#0E0A07", centerRadius: [48, 62],
      vein: "rgba(35,82,222,0.34)",
      pollen: "#2352DE", pollenRadius: [68, 88],
      centerShape: "blob"
    },
    {
      // 4 — seven petals, blue at the base and purple at the tips
      cx: 301, cy: 299,
      angles: [193, 244, 296, 347, 39, 90, 141],
      lengths: [238, 226, 244, 230, 240, 228, 242],
      spreads: [56, 53, 57, 54, 56, 53, 57],
      petals: ["#8669B9", "#7d5fb3", "#8669B9", "#7256a6", "#8669B9", "#7a5cae", "#8669B9"],
      petalAlpha: 202,
      inner: "#2352DE", innerAlpha: 118,
      center: "#0E0A07", centerRadius: [44, 58],
      vein: "rgba(35,82,222,0.32)",
      pollen: "#2352DE", pollenRadius: [62, 80],
      centerShape: "blob"
    },
    {
      // 5 — four petal pinwheel with a square ink centre, echoing the mark
      cx: 300, cy: 300,
      angles: [225, 315, 45, 135],
      lengths: [248, 238, 250, 240],
      spreads: [86, 82, 88, 83],
      petals: ["#2352DE", "#8669B9", "#2352DE", "#8669B9"],
      petalAlpha: 190,
      inner: "#2352DE", innerAlpha: 72,
      center: "#0E0A07", centerRadius: [50, 50],
      vein: "rgba(14,10,7,0.24)",
      pollen: "#8669B9", pollenRadius: [70, 86],
      centerShape: "square"
    }
  ];

  const design = designs[ART_SEED % designs.length];
  const count = design.angles.length;
  const cx = design.cx;
  const cy = design.cy;

  brush.noField();
  brush.noHatch();

  // outer petal washes, laid down twice so the colour reaches full strength
  brush.set("marker");
  brush.noStroke();
  brush.fillBleed(0.26);
  brush.fillTexture(0.34, 0.44);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      brush.fill(design.petals[i % design.petals.length], design.petalAlpha + (i % 3) * 6);
      petal(
        cx,
        cy,
        design.angles[i] + random(-2.5, 2.5),
        design.lengths[i] * (pass === 0 ? random(0.97, 1.03) : random(0.90, 0.96)),
        design.spreads[i] * (pass === 0 ? 1 : 0.9),
        0.25
      );
    }
  }

  // tighter wash near the heart of each petal
  brush.fillBleed(0.22);
  brush.fillTexture(0.30, 0.38);
  for (let i = 0; i < count; i++) {
    const a = design.angles[i] + random(-4, 4);
    const len = design.lengths[i] * random(0.38, 0.50);
    const spread = design.spreads[i] * 0.38;
    brush.fill(design.inner, design.innerAlpha + (i % 3) * 7);
    brush.beginShape(0.28);
    brush.vertex(cx + cos(a - spread) * 22, cy + sin(a - spread) * 22);
    brush.vertex(cx + cos(a - spread * 0.62) * len * 0.76, cy + sin(a - spread * 0.62) * len * 0.76);
    brush.vertex(cx + cos(a) * len, cy + sin(a) * len);
    brush.vertex(cx + cos(a + spread * 0.62) * len * 0.76, cy + sin(a + spread * 0.62) * len * 0.76);
    brush.vertex(cx + cos(a + spread) * 22, cy + sin(a + spread) * 22);
    brush.endShape(CLOSE);
  }

  // faint veins, held well inside the petal body
  brush.noFill();
  brush.set("cpencil");
  brush.stroke(design.vein);
  brush.strokeWeight(1.3);
  for (let i = 0; i < count; i++) {
    const a = design.angles[i];
    const len = design.lengths[i];
    brush.flowLine(cx + cos(a - 4) * 104, cy + sin(a - 4) * 104, len * 0.22, a - 4);
    brush.flowLine(cx + cos(a + 5) * 112, cy + sin(a + 5) * 112, len * 0.16, a + 5);
  }

  // ink centre, built up in stacked charcoal passes so it lands truly dark
  brush.set("charcoal");
  brush.noStroke();
  brush.fillBleed(0.14);
  brush.fillTexture(0.30, 0.52);
  const centerPasses = design.centerShape === "square" ? 5 : 3;
  for (let pass = 0; pass < centerPasses; pass++) {
    brush.fill(design.center, 255);
    const shrink = 1 - pass * (design.centerShape === "square" ? 0.035 : 0.11);
    if (design.centerShape === "square") {
      const r = design.centerRadius[0] * shrink;
      brush.beginShape(0.06);
      brush.vertex(cx - r, cy - r);
      brush.vertex(cx + r, cy - r);
      brush.vertex(cx + r, cy + r);
      brush.vertex(cx - r, cy + r);
      brush.endShape(CLOSE);
    } else {
      brush.beginShape(0.20);
      for (let i = 0; i < 11; i++) {
        const a = i * (360 / 11) + random(-6, 6);
        const r = random(design.centerRadius[0], design.centerRadius[1]) * shrink;
        brush.vertex(cx + cos(a) * r, cy + sin(a) * r);
      }
      brush.endShape(CLOSE);
    }
  }

  // grain across the ink centre
  brush.noFill();
  brush.set("charcoal");
  brush.stroke(design.center);
  for (let i = 0; i < 26; i++) {
    const a = random(360);
    const r = random(0, design.centerRadius[0] * (design.centerShape === "square" ? 0.6 : 0.78));
    brush.strokeWeight(random(2.4, 5.2));
    brush.circle(cx + cos(a) * r, cy + sin(a) * r, random(5, 16));
  }

  // stamen flecks, ringing the ink centre
  brush.set("marker");
  brush.noFill();
  brush.stroke(design.pollen);
  brush.strokeWeight(5.0);
  for (let i = 0; i < 12; i++) {
    const a = i * 30 + random(-8, 8);
    const r = random(design.pollenRadius[0], design.pollenRadius[1]);
    const x = cx + cos(a) * r;
    const y = cy + sin(a) * r;
    const d = random(3.0, 6.0);
    brush.line(x, y, x + cos(a + 72) * d, y + sin(a + 72) * d);
  }

  noLoop();
  window.__ART_READY__ = true;
}
