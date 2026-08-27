// Pixel-content regression test for the OG renderer.
//
// The other /og tests (og.test.ts) only check HTTP status, headers, and PNG
// byte-size — none of them decode the image, so a real bug shipped
// undetected across multiple releases: a pinned workers-og version (Satori
// build) rendered wrapped multi-line titles with the lines overlapping into
// an illegible smear instead of stacking cleanly. Fixed by upgrading
// workers-og 0.0.14 -> 0.0.27; this test decodes actual rendered pixels so a
// regression of that specific defect fails the suite instead of shipping
// silently again.
import { decode as decodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { registerKey, request } from './helpers';

// Long enough to force the default template's title (fontSize 42px past the
// 60-char threshold) to wrap across two lines at 1200x630.
const WRAPPING_TITLE =
  'SnapOG generates share-ready Open Graph images for every page automatically';

// Column window that only ever contains title-text ink: it clears the
// AccentBar (x < 6) on the left and the free-tier watermark, which is
// right-aligned near x > 1050, on the right. Domain/tag/author are omitted
// from the request so Header/Footer render no other visible glyphs.
const SCAN_X_START = 100;
const SCAN_X_END = 800;

interface InkBand {
  startRow: number;
  endRow: number;
}

// Groups contiguous (or near-contiguous, allowing a 1-row anti-aliasing gap)
// rows that contain non-background ink into bands. Two cleanly stacked text
// lines produce two bands with a real gap between them; overlapping/smeared
// lines produce one merged band (or no gap), which is exactly the defect
// this test guards against.
function findInkBands(rowHasInk: boolean[]): InkBand[] {
  const bands: InkBand[] = [];
  let current: InkBand | null = null;
  let gapRun = 0;

  for (let row = 0; row < rowHasInk.length; row++) {
    if (rowHasInk[row]) {
      if (current === null) {
        current = { startRow: row, endRow: row };
      } else {
        current.endRow = row;
      }
      gapRun = 0;
    } else if (current !== null) {
      gapRun++;
      if (gapRun > 1) {
        bands.push(current);
        current = null;
      }
    }
  }
  if (current !== null) bands.push(current);
  return bands;
}

describe('GET /og — rendered pixel content', () => {
  it('renders a wrapped two-line title as two distinct, non-overlapping ink bands', async () => {
    const { rawKey } = await registerKey();
    const res = await request(
      `/og?title=${encodeURIComponent(WRAPPING_TITLE)}&key=${rawKey}`
    );
    expect(res.status).toBe(200);

    const buf = await res.arrayBuffer();
    const png = decodePng(new Uint8Array(buf));
    expect(png.width).toBe(1200);
    expect(png.height).toBe(630);

    const channels = png.data.length / (png.width * png.height);
    expect(channels).toBeGreaterThanOrEqual(3); // RGB or RGBA

    // Background is dark theme's #0A0A0A. A pixel counts as "ink" if any
    // channel deviates from that background by more than anti-aliasing
    // noise would produce for an untouched background pixel.
    const bg = [0x0a, 0x0a, 0x0a];
    const INK_THRESHOLD = 25;

    const rowHasInk: boolean[] = new Array(png.height).fill(false);
    for (let y = 0; y < png.height; y++) {
      for (let x = SCAN_X_START; x < SCAN_X_END; x++) {
        const i = (y * png.width + x) * channels;
        const dr = Math.abs(png.data[i] - bg[0]);
        const dg = Math.abs(png.data[i + 1] - bg[1]);
        const db = Math.abs(png.data[i + 2] - bg[2]);
        if (dr > INK_THRESHOLD || dg > INK_THRESHOLD || db > INK_THRESHOLD) {
          rowHasInk[y] = true;
          break;
        }
      }
    }

    const bands = findInkBands(rowHasInk);

    // Diagnostic context if this ever fails: dump the band ranges so a
    // human/agent can see whether lines merged (1 band) or something else
    // shifted (0, or >2 bands from unrelated layout drift) without having
    // to re-render and inspect a PNG by hand.
    expect(
      bands.length,
      `expected 2 distinct title-line ink bands, got ${bands.length}: ${JSON.stringify(bands)}`
    ).toBe(2);

    const [line1, line2] = bands;
    // The bug this guards against made line 1 and line 2 overlap/merge.
    // A real gap between bands is the signal that they're legible, separate
    // lines rather than a smeared blob.
    expect(line2.startRow).toBeGreaterThan(line1.endRow);
    const gap = line2.startRow - line1.endRow;
    expect(gap, `gap between title lines was only ${gap}px — lines may be overlapping`).toBeGreaterThanOrEqual(2);

    // Each band should have real height (a rendered line of 42px bold text),
    // not a 1px sliver from noise.
    expect(line1.endRow - line1.startRow).toBeGreaterThan(10);
    expect(line2.endRow - line2.startRow).toBeGreaterThan(10);
  });
});
