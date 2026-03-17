/**
 * PastureAnimator — animates cows wandering over pasture regions.
 *
 * Cows use stateless sine-based wander (like RiverAnimator wave phase)
 * so positions are deterministic at any given timeMs with no accumulated state.
 *
 * Each frame: restore interior pasture pixels (erase prev cows), then
 * stamp new cow positions.
 *
 * Cow sprite (4×3, Holstein 3/4 perspective):
 *   _ W B W
 *   W W W B
 *   B _ W _
 *
 * Mirrored when moving left:
 *   W B W _
 *   B W W W
 *   _ W _ B
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import type { PastureData } from './FarmRenderer';
import { Season } from '../state/Season';

// ── Cow sprite ────────────────────────────────────────────────────────────────
const COW_W = 4;
const COW_H = 3;
const COW_BODY  = packABGR(0xe8, 0xe0, 0xd0);  // off-white
const COW_PATCH = packABGR(0x1c, 0x18, 0x18);  // near-black Holstein spot
const _ = -1;  // transparent

// [row][col]: -1 = skip, 0 = body, 1 = patch
const COW_RIGHT: number[][] = [
  [_, 0, 1, 0],
  [0, 0, 0, 1],
  [1, _, 0, _],
];
const COW_LEFT: number[][] = [
  [0, 1, 0, _],
  [1, 0, 0, 0],
  [_, 0, _, 1],
];

// ── Cow instance ──────────────────────────────────────────────────────────────
interface CowState {
  // Home position (center of wander) in absolute pixel coords
  homeX: number;
  homeY: number;
  // Sine wander parameters
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
  radiusX: number;
  radiusY: number;
  // Sprite variant (slight patch variation)
  mirrorBase: boolean;
}

interface PastureInstance {
  cows: CowState[];
  interiorPixels: { idx: number; color: number }[];
  minX: number; maxX: number; minY: number; maxY: number;
}

// ─────────────────────────────────────────────────────────────────────────────
export class PastureAnimator {
  extrusionMap: Int16Array | null = null;

  private _pastures: PastureInstance[] = [];
  private _N: number;
  private _season: Season;

  constructor(
    pastureData: PastureData[],
    N: number,
    seed: number,
    season: Season,
  ) {
    this._N = N;
    this._season = season;

    for (const pd of pastureData) {
      const rng = mulberry32(seed ^ (pd.regionIndex * 0x1b3c5a));
      const { minX, maxX, minY, maxY, interiorPixels } = pd;

      const innerW = maxX - minX;
      const innerH = maxY - minY;
      if (innerW < 8 || innerH < 8) continue;

      // Number of cows scales with area
      const area = innerW * innerH;
      const numCows = Math.max(1, Math.min(4, Math.floor(area / 120)));

      const cows: CowState[] = [];
      for (let ci = 0; ci < numCows; ci++) {
        // Distribute home positions across the pasture
        const gridCols = numCows <= 2 ? numCows : 2;
        const gridRows = Math.ceil(numCows / gridCols);
        const col = ci % gridCols;
        const row = Math.floor(ci / gridCols);
        const homeX = minX + (col + 1) * innerW / (gridCols + 1) + (rng() - 0.5) * 6;
        const homeY = minY + (row + 1) * innerH / (gridRows + 1) + (rng() - 0.5) * 4;

        cows.push({
          homeX: Math.round(homeX),
          homeY: Math.round(homeY),
          phaseX: rng() * Math.PI * 2,
          phaseY: rng() * Math.PI * 2,
          freqX: 0.00045 + rng() * 0.00020,
          freqY: 0.00038 + rng() * 0.00018,
          radiusX: Math.min(innerW * 0.22, 8),
          radiusY: Math.min(innerH * 0.18, 6),
          mirrorBase: rng() > 0.5,
        });
      }

      this._pastures.push({ cows, interiorPixels, minX, maxX, minY, maxY });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    // No cows in winter
    if (this._season === Season.Winter) return;

    const N = this._N;
    const ext = this.extrusionMap;

    for (const pasture of this._pastures) {
      // Restore interior grass pixels at their extruded screen positions
      for (const p of pasture.interiorPixels) {
        const outIdx = this._screenIdx(p.idx, N, ext);
        if (outIdx < 0) continue;
        pixels[outIdx] = p.color;
      }

      // Stamp cows at new positions (source coords → screen coords via extrusion)
      for (const cow of pasture.cows) {
        const cx = Math.round(cow.homeX + Math.sin(timeMs * cow.freqX + cow.phaseX) * cow.radiusX);
        const cy = Math.round(cow.homeY + Math.sin(timeMs * cow.freqY + cow.phaseY) * cow.radiusY);

        // Clamp to pasture source bounds with margin for sprite size
        const sx = Math.max(pasture.minX, Math.min(pasture.maxX - COW_W, cx));
        const sy = Math.max(pasture.minY, Math.min(pasture.maxY - COW_H, cy));

        // Face direction based on horizontal velocity
        const vx = Math.cos(timeMs * cow.freqX + cow.phaseX);
        const facingRight = cow.mirrorBase ? vx > 0 : vx <= 0;
        const sprite = facingRight ? COW_RIGHT : COW_LEFT;

        // Draw cow sprite — convert each source pixel to screen position
        for (let row = 0; row < COW_H; row++) {
          for (let col = 0; col < COW_W; col++) {
            const cell = sprite[row][col];
            if (cell === _) continue;
            const px = sx + col;
            const py = sy + row;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;
            const srcIdx = py * N + px;
            const outIdx = this._screenIdx(srcIdx, N, ext);
            if (outIdx < 0) continue;
            pixels[outIdx] = cell === 0 ? COW_BODY : COW_PATCH;
          }
        }
      }
    }
  }

  // Convert source pixel index to screen index via extrusionMap (mirrors RiverAnimator)
  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    const px = srcIdx % N;
    const py = (srcIdx - px) / N;
    const screenY = py - ext[srcIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + px;
  }
}
