// Shared pixel-content regression helpers for OG template tests.
//
// Extracted from the original default-template test (og-render.test.ts) so
// the same "decode real PNG pixels, group into ink bands" technique can be
// reused across templates without duplicating the scan/grouping logic.
import type { DecodedPng } from 'fast-png';

export interface InkBand {
  startRow: number;
  endRow: number;
}

export interface InkScanOptions {
  /** Column range to scan, inclusive start / exclusive end. Pick a window
   *  that contains title-text ink but excludes template chrome (accent
   *  bars, dividers, watermark) that lives at other x positions. */
  xStart: number;
  xEnd: number;
  /** Background color to diff against, as [r, g, b]. */
  bg: [number, number, number];
  /** Per-channel delta above which a pixel counts as "ink". */
  inkThreshold?: number;
  /** Bands shorter than this (px) are dropped before returning — this
   *  filters out thin decorative lines (divider rules, accent bars) that
   *  happen to fall inside the x-window but aren't text, so callers don't
   *  have to hand-tune the x-window to dodge every hairline in a layout. */
  minBandHeight?: number;
}

/** Groups contiguous (or near-contiguous, allowing a 1-row anti-aliasing
 *  gap) rows that contain non-background ink into bands. Two cleanly
 *  stacked text lines produce two bands with a real gap between them;
 *  overlapping/smeared lines produce one merged band (or no gap). */
function groupRowsIntoBands(rowHasInk: boolean[]): InkBand[] {
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

export function computeInkBands(png: DecodedPng, opts: InkScanOptions): InkBand[] {
  const { xStart, xEnd, bg, inkThreshold = 25, minBandHeight = 0 } = opts;
  const channels = png.data.length / (png.width * png.height);

  const rowHasInk: boolean[] = new Array(png.height).fill(false);
  for (let y = 0; y < png.height; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = (y * png.width + x) * channels;
      const dr = Math.abs(png.data[i] - bg[0]);
      const dg = Math.abs(png.data[i + 1] - bg[1]);
      const db = Math.abs(png.data[i + 2] - bg[2]);
      if (dr > inkThreshold || dg > inkThreshold || db > inkThreshold) {
        rowHasInk[y] = true;
        break;
      }
    }
  }

  const bands = groupRowsIntoBands(rowHasInk);
  return bands.filter(b => b.endRow - b.startRow >= minBandHeight);
}
