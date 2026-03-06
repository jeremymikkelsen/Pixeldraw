/**
 * DuchyRenderer
 *
 * Renders duchy territories onto the pixel buffer:
 *  1. Territory tint: blend duchy color into ground pixels (15% opacity)
 *  2. Boundary lines: 2px dark borders between different duchies
 */

import { GameState } from '../state/GameState';

// Blend factor for duchy territory tinting
const TINT_ALPHA = 0.15;
// Border brightness boost (1.0 = original, >1.0 = brighter)
const BORDER_BRIGHTEN = 1.6;
// Minimum brightness for border channels so dark colors are still visible
const BORDER_MIN = 80;

/**
 * Apply duchy territory tint and borders to an existing pixel buffer.
 * Must be called after GroundRenderer and before TreeRenderer.
 *
 * @param pixels - The ABGR pixel buffer to modify in-place
 * @param regionGrid - Per-pixel region assignment (from GroundRenderer)
 * @param state - The current game state
 * @param resolution - Pixel buffer width/height
 */
export function renderDuchies(
  pixels: Uint32Array,
  regionGrid: Uint16Array,
  state: GameState,
  resolution: number,
): void {
  const N = resolution;
  const total = N * N;
  const { regionToDuchy, duchies } = state;

  // Pre-extract duchy colors as RGB components for fast blending
  const duchyR = new Uint8Array(duchies.length);
  const duchyG = new Uint8Array(duchies.length);
  const duchyB = new Uint8Array(duchies.length);
  for (let d = 0; d < duchies.length; d++) {
    const c = duchies[d].house.color;
    duchyR[d] = (c >> 16) & 0xff;
    duchyG[d] = (c >> 8) & 0xff;
    duchyB[d] = c & 0xff;
  }

  // Pass 1: Territory tint
  for (let i = 0; i < total; i++) {
    const region = regionGrid[i];
    const duchyIdx = regionToDuchy[region];
    if (duchyIdx < 0) continue;

    // Extract current pixel color (ABGR format)
    const px = pixels[i];
    const pr = px & 0xff;
    const pg = (px >> 8) & 0xff;
    const pb = (px >> 16) & 0xff;

    // Blend with duchy color
    const nr = Math.floor(pr * (1 - TINT_ALPHA) + duchyR[duchyIdx] * TINT_ALPHA);
    const ng = Math.floor(pg * (1 - TINT_ALPHA) + duchyG[duchyIdx] * TINT_ALPHA);
    const nb = Math.floor(pb * (1 - TINT_ALPHA) + duchyB[duchyIdx] * TINT_ALPHA);

    pixels[i] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
  }

  // Pass 2: Boundary lines between different duchies
  for (let py = 1; py < N - 1; py++) {
    for (let px = 1; px < N - 1; px++) {
      const i = py * N + px;
      const region = regionGrid[i];
      const duchyIdx = regionToDuchy[region];
      if (duchyIdx < 0) continue;

      // Check 4 neighbors for different duchy
      let isBorder = false;
      const neighbors = [i - 1, i + 1, i - N, i + N];
      for (const ni of neighbors) {
        const nRegion = regionGrid[ni];
        const nDuchy = regionToDuchy[nRegion];
        if (nDuchy !== duchyIdx) {
          isBorder = true;
          break;
        }
      }

      if (isBorder) {
        // Draw border: bright saturated duchy color
        const dr = Math.min(255, Math.max(BORDER_MIN, Math.floor(duchyR[duchyIdx] * BORDER_BRIGHTEN)));
        const dg = Math.min(255, Math.max(BORDER_MIN, Math.floor(duchyG[duchyIdx] * BORDER_BRIGHTEN)));
        const db = Math.min(255, Math.max(BORDER_MIN, Math.floor(duchyB[duchyIdx] * BORDER_BRIGHTEN)));
        pixels[i] = (255 << 24) | (db << 16) | (dg << 8) | dr;
      }
    }
  }
}
