// Pixel-content regression tests for the `blog` and `article` OG templates.
//
// og-render.test.ts closed this gap for the `default` template only: the
// multi-line title-overlap bug (fixed by upgrading workers-og 0.0.14 ->
// 0.0.27) could still ship silently for `blog`/`article` since they share
// the same wrap-prone title layout but had no pixel-level coverage. These
// tests apply the identical technique (decode the rendered PNG, group ink
// rows into bands, assert a wrapped title forms exactly 2 distinct
// non-overlapping bands) to both remaining templates.
//
// Each template has its own decorative chrome (blog: a full-width 4px top
// band; article: a short accent divider under the category row plus a
// full-width 1px footer divider) that can register as ink within a naive
// x-window. minBandHeight filters those out structurally — they're a few
// px tall, while a rendered 40-64px bold text line is not — so the x-window
// only needs to dodge the title-adjacent watermark, not every hairline.
import { decode as decodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { computeInkBands } from './ink-bands';
import { registerKey, request } from './helpers';

const WRAPPING_TITLE =
  'SnapOG generates share-ready Open Graph images for every page automatically';

interface TemplateCase {
  template: 'blog' | 'article';
  bg: [number, number, number];
  scanXStart: number;
  scanXEnd: number;
}

const CASES: TemplateCase[] = [
  // Blog: bg #0D0D0D, padding 72px 80px. Watermark is right-aligned near
  // the far edge (~x>1030); a 4px accent band spans the full top edge and
  // is filtered out via minBandHeight rather than avoided by column.
  { template: 'blog', bg: [0x0d, 0x0d, 0x0d], scanXStart: 100, scanXEnd: 800 },
  // Article: bg #111111, padding 60px 72px. The category-row accent
  // divider sits at x:72-120, so start the scan past it; the full-width 1px
  // footer divider is filtered out via minBandHeight.
  { template: 'article', bg: [0x11, 0x11, 0x11], scanXStart: 150, scanXEnd: 800 },
];

describe.each(CASES)(
  'GET /og?template=$template — rendered pixel content',
  ({ template, bg, scanXStart, scanXEnd }) => {
    it('renders a wrapped two-line title as two distinct, non-overlapping ink bands', async () => {
      const { rawKey } = await registerKey();
      const res = await request(
        `/og?template=${template}&title=${encodeURIComponent(WRAPPING_TITLE)}&key=${rawKey}`
      );
      expect(res.status).toBe(200);

      const buf = await res.arrayBuffer();
      const png = decodePng(new Uint8Array(buf));
      expect(png.width).toBe(1200);
      expect(png.height).toBe(630);

      const bands = computeInkBands(png, {
        xStart: scanXStart,
        xEnd: scanXEnd,
        bg,
        minBandHeight: 8,
      });

      expect(
        bands.length,
        `expected 2 distinct title-line ink bands, got ${bands.length}: ${JSON.stringify(bands)}`
      ).toBe(2);

      const [line1, line2] = bands;
      expect(line2.startRow).toBeGreaterThan(line1.endRow);
      const gap = line2.startRow - line1.endRow;
      expect(
        gap,
        `gap between title lines was only ${gap}px — lines may be overlapping`
      ).toBeGreaterThanOrEqual(2);

      expect(line1.endRow - line1.startRow).toBeGreaterThan(10);
      expect(line2.endRow - line2.startRow).toBeGreaterThan(10);
    });
  }
);
