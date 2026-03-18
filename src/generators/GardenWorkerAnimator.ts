/**
 * GardenWorkerAnimator — a lone gardener mulling about in each garden region.
 *
 * Uses stateless sine-based wander (same approach as PastureAnimator cows).
 * The gardener uses the same 2×3 walking person sprite as RoadTravelerAnimator.
 * Active in spring, summer, and fall only.
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import type { GardenData } from './FarmRenderer';
import { Season } from '../state/Season';

// ── Person sprite (same as RoadTravelerAnimator) ──────────────────────────────
const PERSON_HEAD = packABGR(0xc8, 0xa8, 0x80);
const PERSON_BODY = packABGR(0x4a, 0x5a, 0x78);
const PERSON_LEG  = packABGR(0x5a, 0x48, 0x38);

const _ = -1;

const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _], [1, 1], [_, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_, 0], [1, 1], [2, _]] };
const PERSON_COLORS = [PERSON_HEAD, PERSON_BODY, PERSON_LEG];

const EDGE_INSET = 3;

interface WorkerState {
  homeX: number;
  homeY: number;
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
  radiusX: number;
  radiusY: number;
  mirrorBase: boolean;
  minX: number; maxX: number; minY: number; maxY: number;
}

export class GardenWorkerAnimator {
  extrusionMap: Int16Array | null = null;

  private _workers: WorkerState[] = [];
  private _N: number;
  private _season: Season;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();

  constructor(
    gardenData: GardenData[],
    N: number,
    seed: number,
    season: Season,
  ) {
    this._N = N;
    this._season = season;

    for (const gd of gardenData) {
      const rng = mulberry32(seed ^ (gd.regionIndex * 0x2c7f3a));
      const { minX, maxX, minY, maxY } = gd;

      const innerW = maxX - minX;
      const innerH = maxY - minY;
      if (innerW < 12 || innerH < 12) continue;

      const safeMinX = minX + EDGE_INSET;
      const safeMaxX = maxX - EDGE_INSET;
      const safeMinY = minY + EDGE_INSET;
      const safeMaxY = maxY - EDGE_INSET;

      if (safeMaxX <= safeMinX || safeMaxY <= safeMinY) continue;

      const safeW = safeMaxX - safeMinX;
      const safeH = safeMaxY - safeMinY;

      // 1 worker, occasionally 2 for larger gardens
      const numWorkers = (innerW * innerH > 600 && rng() > 0.5) ? 2 : 1;

      for (let wi = 0; wi < numWorkers; wi++) {
        const homeX = safeMinX + (wi + 1) * safeW / (numWorkers + 1) + (rng() - 0.5) * 4;
        const homeY = safeMinY + safeH * (0.3 + rng() * 0.4);

        this._workers.push({
          homeX: Math.round(homeX),
          homeY: Math.round(homeY),
          phaseX: rng() * Math.PI * 2,
          phaseY: rng() * Math.PI * 2,
          freqX: 0.00018 + rng() * 0.00010,
          freqY: 0.00015 + rng() * 0.00009,
          radiusX: Math.min(safeW * 0.38, 22),
          radiusY: Math.min(safeH * 0.32, 16),
          mirrorBase: rng() > 0.5,
          minX: safeMinX, maxX: safeMaxX,
          minY: safeMinY, maxY: safeMaxY,
        });
      }
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    // 1. Restore pixels overwritten last frame
    for (const d of this._dirty) {
      pixels[d.screenIdx] = d.color;
    }
    this._dirty = [];
    this._savedThisFrame = new Set<number>();

    // Workers rest in winter
    if (this._season === Season.Winter) return;

    // 2. Stamp workers at new positions
    for (const w of this._workers) {
      const cx = Math.round(w.homeX + Math.sin(timeMs * w.freqX + w.phaseX) * w.radiusX);
      const cy = Math.round(w.homeY + Math.sin(timeMs * w.freqY + w.phaseY) * w.radiusY);

      const sx = Math.max(w.minX, Math.min(w.maxX - 2, cx));
      const sy = Math.max(w.minY, Math.min(w.maxY - 3, cy));

      const vx = Math.cos(timeMs * w.freqX + w.phaseX);
      const facingRight = w.mirrorBase ? vx > 0 : vx <= 0;
      const sprite = facingRight ? PERSON_RIGHT : PERSON_LEFT;

      for (let row = 0; row < sprite.h; row++) {
        for (let col = 0; col < sprite.w; col++) {
          const cell = sprite.cells[row][col];
          if (cell === _) continue;

          const px = sx + col;
          const py = sy + row;
          if (px < 0 || px >= N || py < 0 || py >= N) continue;

          const srcIdx = py * N + px;
          const screenIdx = this._screenIdx(srcIdx, N, ext);
          if (screenIdx < 0) continue;

          if (!this._savedThisFrame.has(screenIdx)) {
            this._dirty.push({ screenIdx, color: pixels[screenIdx] });
            this._savedThisFrame.add(screenIdx);
          }
          pixels[screenIdx] = PERSON_COLORS[cell];
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
