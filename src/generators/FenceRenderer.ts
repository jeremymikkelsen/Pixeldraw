/**
 * FenceRenderer — draws 3/4-perspective post-and-rail fences around pastures.
 *
 * Each pasture gets:
 *   - 4 corner posts: 3 pixels tall, inset 2px from the bounding-box edges
 *   - 4 single-pixel rails connecting post midpoints (height = base − 1)
 *
 * Layer split (3/4 depth illusion):
 *   BACK  — top rail, left rail, right rail, top-left and top-right posts
 *           Written directly into the pixel buffer (static; cows walk in front).
 *   FRONT — bottom rail, bottom-left and bottom-right posts
 *           Returned as `frontFence` so the caller can restore them each frame
 *           on top of the cow layer.
 *
 * All coordinates are source-space; extrusion is applied to convert to screen-space.
 */

import { packABGR } from './TerrainPalettes';
import type { PastureData } from './FarmRenderer';

const FENCE_POST = packABGR(0x4c, 0x32, 0x18);   // dark post wood
const FENCE_RAIL = packABGR(0x6e, 0x4c, 0x26);   // lighter rail wood

export class FenceRenderer {
  render(
    pixels: Uint32Array,
    pastures: PastureData[],
    ext: Int16Array | null,
    N: number,
  ): { frontFence: { idx: number; color: number }[] } {
    const frontFence: { idx: number; color: number }[] = [];

    for (const pd of pastures) {
      const { minX, maxX, minY, maxY } = pd;
      if (maxX - minX < 8 || maxY - minY < 8) continue;

      // Corner post positions (2px inset)
      const px0 = minX + 2, px1 = maxX - 2;
      const py0 = minY + 2, py1 = maxY - 2;

      // ── BACK layer (static) ──────────────────────────────────────────────
      // Top posts
      this._post(pixels, px0, py0, N, ext, null);
      this._post(pixels, px1, py0, N, ext, null);
      // Top rail
      this._hRail(pixels, py0, px0, px1, N, ext, null);
      // Side rails (full span, back layer only)
      this._vRail(pixels, px0, py0, py1, N, ext, null);
      this._vRail(pixels, px1, py0, py1, N, ext, null);

      // ── FRONT layer (captured for per-frame restore over cows) ───────────
      // Bottom posts
      this._post(pixels, px0, py1, N, ext, frontFence);
      this._post(pixels, px1, py1, N, ext, frontFence);
      // Bottom rail
      this._hRail(pixels, py1, px0, px1, N, ext, frontFence);
    }

    return { frontFence };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** 3-pixel tall post at source (px, py), extending upward from terrain base. */
  private _post(
    pixels: Uint32Array,
    px: number, py: number,
    N: number, ext: Int16Array | null,
    capture: { idx: number; color: number }[] | null,
  ): void {
    const base = this._sBase(py * N + px, py, ext);
    for (let h = 0; h < 3; h++) {
      const sy = base - h;
      if (sy < 0 || sy >= N) continue;
      const si = sy * N + px;
      pixels[si] = FENCE_POST;
      if (capture) capture.push({ idx: si, color: FENCE_POST });
    }
  }

  /** Single-pixel horizontal rail at height 1 above terrain base, py=const. */
  private _hRail(
    pixels: Uint32Array,
    py: number, px0: number, px1: number,
    N: number, ext: Int16Array | null,
    capture: { idx: number; color: number }[] | null,
  ): void {
    for (let px = px0; px <= px1; px++) {
      const sy = this._sBase(py * N + px, py, ext) - 1;
      if (sy < 0 || sy >= N) continue;
      const si = sy * N + px;
      pixels[si] = FENCE_RAIL;
      if (capture) capture.push({ idx: si, color: FENCE_RAIL });
    }
  }

  /** Single-pixel vertical rail at height 1 above terrain base, px=const. */
  private _vRail(
    pixels: Uint32Array,
    px: number, py0: number, py1: number,
    N: number, ext: Int16Array | null,
    capture: { idx: number; color: number }[] | null,
  ): void {
    for (let py = py0; py <= py1; py++) {
      const sy = this._sBase(py * N + px, py, ext) - 1;
      if (sy < 0 || sy >= N) continue;
      const si = sy * N + px;
      pixels[si] = FENCE_RAIL;
      if (capture) capture.push({ idx: si, color: FENCE_RAIL });
    }
  }

  private _sBase(srcIdx: number, py: number, ext: Int16Array | null): number {
    return ext ? py - ext[srcIdx] : py;
  }
}
