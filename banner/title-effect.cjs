/*
 * OMP STORM — CYCLONE title treatment.
 * The host registers "Storm Display" and "Storm Text" before construction.
 * Coordinates, font sizes, tracking, subtitle, accent, and background wash
 * match the original CYCLONE title(p). Only the OMP/STORM fill is animated.
 */
'use strict';

exports.createTitleLayer = function createTitleLayer({ createCanvas, width = 1600, height = 600 }) {
  if (typeof createCanvas !== 'function') throw new TypeError('createCanvas must be a function');
  const W = width, H = height, TAU = Math.PI * 2;
  const maskCanvas = createCanvas(W, H), mask = maskCanvas.getContext('2d');
  const paintCanvas = createCanvas(W, H), paint = paintCanvas.getContext('2d');
  const outputCanvas = createCanvas(W, H), output = outputCanvas.getContext('2d');

  // Small labels, sized so they stay readable when GitHub shows the banner
  // about 850 px wide (v2 used OMP 19px / tracking 7, subtitle 13px / 2.1
  // at baseline 386, accent bar at y=183). The accent bar moves up and the
  // subtitle baseline down so the block's spacing and centre stay as before.
  const OMP_SIZE = 28, OMP_TRACKING = 9;
  const SUBTITLE_SIZE = 22, SUBTITLE_TRACKING = 3.6, SUBTITLE_BASELINE = 392;
  const ACCENT_Y = 175;

  const BASE_OMP = '#9eafb6';
  const BASE_STORM = '#f0f4f3';
  const ICE = [139, 204, 219];

  function trackedText(context, text, x, baseline, tracking) {
    for (const char of text) {
      context.fillText(char, x, baseline);
      x += context.measureText(char).width + tracking;
    }
    return x;
  }

  // A single fixed alpha mask keeps the exact original glyph silhouettes.
  mask.clearRect(0, 0, W, H);
  mask.fillStyle = '#ffffff';
  mask.textAlign = 'left';
  mask.textBaseline = 'alphabetic';
  mask.font = `${OMP_SIZE}px "Storm Text"`;
  trackedText(mask, 'OMP', 99, 226, OMP_TRACKING);
  mask.font = '128px "Storm Display"';
  mask.fillText('STORM', 90, 346);

  // Conservative bounds include every antialiased edge. The moving band is
  // completely outside these bounds before phase wrap, so both sides of the
  // four-second reset contain the identical ordinary base-colored lettering.
  const titleLeft = 86;
  const titleRight = 90 + mask.measureText('STORM').width + 16;
  const bandWidth = Math.max(250, Math.min(330, (titleRight - titleLeft) * .66));
  const halfBand = bandWidth / 2;
  const padding = 30;
  const startCenter = titleLeft - halfBand - padding;
  const endCenter = titleRight + halfBand + padding;

  function normalized(p) {
    if (!Number.isFinite(p)) return 0;
    return ((p % 1) + 1) % 1;
  }

  function paintType(p) {
    const phase = (p * 2) % 1; // Two left-to-right sweeps per eight-second loop.
    const center = startCenter + (endCenter - startCenter) * phase;

    paint.save();
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalAlpha = 1;
    paint.globalCompositeOperation = 'source-over';
    paint.clearRect(0, 0, W, H);

    // OMP and STORM retain their original base colors when the band is away.
    // The OMP glyphs end below y=226; STORM begins below y=240, so this field
    // partition never cuts through either word or its antialiased boundary.
    paint.fillStyle = BASE_STORM;
    paint.fillRect(0, 0, W, H);
    paint.fillStyle = BASE_OMP;
    paint.fillRect(0, 0, W, 240);

    if (center + halfBand > titleLeft && center - halfBand < titleRight) {
      const band = paint.createLinearGradient(center - halfBand, 0, center + halfBand, 0);
      // One broad, restrained wash: ice blue, pearl white, pale lavender.
      // Transparent outer shoulders return precisely to the original fill.
      band.addColorStop(0, 'rgba(159,214,235,0)');
      band.addColorStop(.15, 'rgba(159,214,235,.28)');
      band.addColorStop(.34, 'rgba(159,214,235,.96)');
      band.addColorStop(.52, 'rgba(250,253,252,1)');
      band.addColorStop(.70, 'rgba(198,181,235,.96)');
      band.addColorStop(.87, 'rgba(198,181,235,.28)');
      band.addColorStop(1, 'rgba(198,181,235,0)');
      paint.fillStyle = band;
      paint.fillRect(center - halfBand, 0, bandWidth, H);
    }

    // Apply glyph alpha exactly once: no halo, glow, changing edge opacity,
    // spill outside the letters, or animated opacity on the base title.
    paint.globalCompositeOperation = 'destination-in';
    paint.drawImage(maskCanvas, 0, 0);
    paint.restore();
  }

  function draw(context, phase) {
    const p = normalized(phase);
    paintType(p);
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';

    // Original left-side contrast correction, unchanged.
    const wash = context.createLinearGradient(0, 0, 820, 0);
    wash.addColorStop(0, 'rgba(3,7,10,.32)');
    wash.addColorStop(.67, 'rgba(3,7,10,.16)');
    wash.addColorStop(1, 'rgba(3,7,10,0)');
    context.fillStyle = wash;
    context.fillRect(0, 0, 820, H);

    context.drawImage(paintCanvas, 0, 0);

    // Supporting text stays fixed, outside the animated mask.
    context.fillStyle = '#8fa1ab'; // v2: #81939d; a little lighter so the small label holds up when scaled down
    context.font = `${SUBTITLE_SIZE}px "Storm Text"`;
    trackedText(context, 'MULTI-AGENT ORCHESTRATION', 98, SUBTITLE_BASELINE, SUBTITLE_TRACKING);

    // Preserve the original eight-second accent pulse.
    const signal = (Math.sin(TAU * p) + 1) / 2;
    context.fillStyle = `rgba(${ICE[0]},${ICE[1]},${ICE[2]},${.45 + signal * .4})`;
    context.fillRect(98, ACCENT_Y, 26, 2);
    context.restore();
  }

  // Reuses one transparent full-frame canvas. Encode or copy it before the
  // next call if the caller needs to retain multiple independent snapshots.
  function render(p) {
    output.save();
    output.setTransform(1, 0, 0, 1, 0, 0);
    output.globalAlpha = 1;
    output.globalCompositeOperation = 'source-over';
    output.clearRect(0, 0, W, H);
    draw(output, p);
    output.restore();
    return outputCanvas;
  }

  return { draw, render };
};
