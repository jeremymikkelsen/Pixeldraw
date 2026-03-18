/**
 * PastureAnimator — animates cows wandering over pasture regions.
 *
 * Cows use stateless sine-based wander (like RiverAnimator wave phase)
 * so positions are deterministic at any given timeMs with no accumulated state.
 *
 * Each frame: restore only the pixels that were overwritten last frame,
 * then stamp new cow positions — only on pixels that belong to the pasture.
 *
 * Cow sprite (4×3, Holstein 3/4 perspective):
 *   _ W B W
 *   W W W B
 *   B _ W _
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

// Inset from pasture bounding box — just enough to keep the sprite from clipping
const EDGE_INSET = 2;

// ── Cow instance ──────────────────────────────────────────────────────────────
interface CowState {
  homeX: number;
  homeY: number;
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
  radiusX: number;
  radiusY: number;
  mirrorBase: boolean;
}

interface PastureInstance {
  cows: CowState[];
  /** Set of source-space pixel indices that belong to this pasture */
  validPixels: Set<number>;
  /** Original colors for restoration (keyed by source index) */
  baseColors: Map<number, number>;
  /** Screen-space indices overwritten last frame (for targeted restore) */
  dirtyScreen: { screenIdx: number; srcIdx: number }[];
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
    maxCowsPerPasture: number = 3,
  ) {
    this._N = N;
    this._season = season;

    for (const pd of pastureData) {
      const rng = mulberry32(seed ^ (pd.regionIndex * 0x1b3c5a));
      const { minX, maxX, minY, maxY, interiorPixels } = pd;

      const innerW = maxX - minX;
      const innerH = maxY - minY;
      if (innerW < 10 || innerH < 10) continue;

      // Build set of valid pixel indices and base color map
      const validPixels = new Set<number>();
      const baseColors = new Map<number, number>();
      for (const p of interiorPixels) {
        validPixels.add(p.idx);
        baseColors.set(p.idx, p.color);
      }

      // Number of cows: 1 to maxCowsPerPasture, scaled by area
      const area = innerW * innerH;
      const numCows = Math.max(1, Math.min(maxCowsPerPasture, Math.floor(area / 150)));

      // Inset bounds for cow placement
      const safeMinX = minX + EDGE_INSET;
      const safeMaxX = maxX - EDGE_INSET;
      const safeMinY = minY + EDGE_INSET;
      const safeMaxY = maxY - EDGE_INSET;

      if (safeMaxX <= safeMinX || safeMaxY <= safeMinY) continue;

      const safeW = safeMaxX - safeMinX;
      const safeH = safeMaxY - safeMinY;

      const cows: CowState[] = [];
      for (let ci = 0; ci < numCows; ci++) {
        const gridCols = numCows <= 2 ? numCows : 2;
        const gridRows = Math.ceil(numCows / gridCols);
        const col = ci % gridCols;
        const row = Math.floor(ci / gridCols);
        const homeX = safeMinX + (col + 1) * safeW / (gridCols + 1) + (rng() - 0.5) * 4;
        const homeY = safeMinY + (row + 1) * safeH / (gridRows + 1) + (rng() - 0.5) * 3;

        cows.push({
          homeX: Math.round(homeX),
          homeY: Math.round(homeY),
          phaseX: rng() * Math.PI * 2,
          phaseY: rng() * Math.PI * 2,
          freqX: 0.00045 + rng() * 0.00020,
          freqY: 0.00038 + rng() * 0.00018,
          radiusX: Math.min(safeW * 0.35, 18),
          radiusY: Math.min(safeH * 0.30, 14),
          mirrorBase: rng() > 0.5,
        });
      }

      this._pastures.push({
        cows,
        validPixels,
        baseColors,
        dirtyScreen: [],
        minX: safeMinX,
        maxX: safeMaxX,
        minY: safeMinY,
        maxY: safeMaxY,
      });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    if (this._season === Season.Winter) return;

    const N = this._N;
    const ext = this.extrusionMap;

    for (const pasture of this._pastures) {
      // 1. Restore only the pixels we overwrote last frame
      for (const d of pasture.dirtyScreen) {
        const baseColor = pasture.baseColors.get(d.srcIdx);
        if (baseColor !== undefined) {
          pixels[d.screenIdx] = baseColor;
        }
      }
      pasture.dirtyScreen = [];

      // 2. Stamp cows at new positions
      for (const cow of pasture.cows) {
        const cx = Math.round(cow.homeX + Math.sin(timeMs * cow.freqX + cow.phaseX) * cow.radiusX);
        const cy = Math.round(cow.homeY + Math.sin(timeMs * cow.freqY + cow.phaseY) * cow.radiusY);

        // Clamp to safe bounds
        const sx = Math.max(pasture.minX, Math.min(pasture.maxX - COW_W, cx));
        const sy = Math.max(pasture.minY, Math.min(pasture.maxY - COW_H, cy));

        const vx = Math.cos(timeMs * cow.freqX + cow.phaseX);
        const facingRight = cow.mirrorBase ? vx > 0 : vx <= 0;
        const sprite = facingRight ? COW_RIGHT : COW_LEFT;

        for (let row = 0; row < COW_H; row++) {
          for (let col = 0; col < COW_W; col++) {
            const cell = sprite[row][col];
            if (cell === _) continue;
            const px = sx + col;
            const py = sy + row;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;

            const srcIdx = py * N + px;

            // Only draw on pixels that actually belong to this pasture
            if (!pasture.validPixels.has(srcIdx)) continue;

            const screenIdx = this._screenIdx(srcIdx, N, ext);
            if (screenIdx < 0) continue;

            pixels[screenIdx] = cell === 0 ? COW_BODY : COW_PATCH;
            pasture.dirtyScreen.push({ screenIdx, srcIdx });
          }
        }
      }
    }
  }

  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    const px = srcIdx % N;
    const py = (srcIdx - px) / N;
    const screenY = py - ext[srcIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + px;
  }
}
