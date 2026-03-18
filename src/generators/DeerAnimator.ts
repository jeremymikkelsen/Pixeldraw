/**
 * DeerAnimator — deer that peek out through trees in dense forests.
 *
 * Stateless sine-based visibility: deer fade in and out at different
 * phases so they appear to peek around trees, then retreat.
 *
 * Deer sprite (3×3, top-down overhead):
 *   _ H _      H = head (tan)
 *   B B B      B = body (brown)
 *   _ T _      T = tail (light)
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';

// ── Deer sprite ──────────────────────────────────────────────────────────────
const DEER_W = 3;
const DEER_H = 3;
const DEER_BODY = packABGR(0x6a, 0x42, 0x22);  // warm brown
const DEER_HEAD = packABGR(0xa0, 0x78, 0x48);   // tan
const DEER_TAIL = packABGR(0xd8, 0xc8, 0xb0);   // pale

const _ = -1;
const H = 0;  // head
const B = 1;  // body
const T = 2;  // tail

const DEER_RIGHT: number[][] = [
  [_, H, _],
  [B, B, B],
  [_, _, T],
];
const DEER_LEFT: number[][] = [
  [_, H, _],
  [B, B, B],
  [T, _, _],
];
const DEER_COLORS = [DEER_HEAD, DEER_BODY, DEER_TAIL];

// ── Minimum trees in region to qualify ────────────────────────────────────────
const MIN_TREE_PIXELS_RATIO = 0.15;  // 15% of region pixels must be trees
const DEER_CHANCE = 0.05;            // 5% of qualifying regions get a deer

// ── Deer instance ────────────────────────────────────────────────────────────
interface DeerState {
  homeX: number;
  homeY: number;
  phaseX: number;
  phaseY: number;
  phaseVis: number;  // visibility phase (peek in/out)
  freqX: number;
  freqY: number;
  freqVis: number;
  radiusX: number;
  radiusY: number;
  mirrorBase: boolean;
}

interface ForestDeer {
  deer: DeerState;
  /** Set of source-space pixel indices that are valid ground (not tree) */
  validPixels: Set<number>;
  /** Original colors for restoration */
  baseColors: Map<number, number>;
  /** Screen pixels overwritten last frame */
  dirtyScreen: { screenIdx: number; srcIdx: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
export class DeerAnimator {
  extrusionMap: Int16Array | null = null;

  private _deers: ForestDeer[] = [];
  private _N: number;
  private _season: Season;

  constructor(
    regionGrid: Uint16Array,
    treeMask: Uint8Array,
    pixels: Uint32Array,
    N: number,
    numRegions: number,
    seed: number,
    season: Season,
  ) {
    this._N = N;
    this._season = season;

    const rng = mulberry32(seed ^ 0xDE3A0001);

    // Count tree pixels and total pixels per region
    const regionTreeCount = new Uint32Array(numRegions);
    const regionTotalCount = new Uint32Array(numRegions);

    for (let i = 0; i < N * N; i++) {
      const r = regionGrid[i];
      if (r >= numRegions) continue;
      regionTotalCount[r]++;
      if (treeMask[i]) regionTreeCount[r]++;
    }

    // Find qualifying regions and pick 5% for deer
    for (let r = 0; r < numRegions; r++) {
      if (regionTotalCount[r] < 50) continue;
      const ratio = regionTreeCount[r] / regionTotalCount[r];
      if (ratio < MIN_TREE_PIXELS_RATIO) continue;
      if (rng() > DEER_CHANCE) continue;

      // Collect ground pixels (not tree, not edge) in this region
      const validPixels = new Set<number>();
      const baseColors = new Map<number, number>();
      let sumX = 0, sumY = 0, count = 0;

      for (let i = 0; i < N * N; i++) {
        if (regionGrid[i] !== r) continue;
        if (treeMask[i]) continue; // skip tree pixels — deer on ground only

        const px = i % N;
        const py = (i - px) / N;

        // Skip edges of map
        if (px < 6 || py < 6 || px >= N - 6 || py >= N - 6) continue;

        validPixels.add(i);
        baseColors.set(i, pixels[i]);
        sumX += px;
        sumY += py;
        count++;
      }

      if (count < 20) continue;

      // Place deer near the center of ground pixels
      const centerX = sumX / count;
      const centerY = sumY / count;

      const deer: DeerState = {
        homeX: Math.round(centerX + (rng() - 0.5) * 10),
        homeY: Math.round(centerY + (rng() - 0.5) * 8),
        phaseX: rng() * Math.PI * 2,
        phaseY: rng() * Math.PI * 2,
        phaseVis: rng() * Math.PI * 2,
        freqX: 0.0003 + rng() * 0.0002,
        freqY: 0.00025 + rng() * 0.00015,
        freqVis: 0.0004 + rng() * 0.0003,  // peek cycle ~10-16 seconds
        radiusX: 4 + rng() * 4,
        radiusY: 3 + rng() * 3,
        mirrorBase: rng() > 0.5,
      };

      this._deers.push({
        deer,
        validPixels,
        baseColors,
        dirtyScreen: [],
      });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    // No deer in winter (they retreat)
    if (this._season === Season.Winter) return;

    const N = this._N;
    const ext = this.extrusionMap;

    for (const fd of this._deers) {
      // 1. Restore pixels from last frame
      for (const d of fd.dirtyScreen) {
        const baseColor = fd.baseColors.get(d.srcIdx);
        if (baseColor !== undefined) {
          pixels[d.screenIdx] = baseColor;
        }
      }
      fd.dirtyScreen = [];

      // 2. Check visibility — deer peeks in and out
      const vis = Math.sin(timeMs * fd.deer.freqVis + fd.deer.phaseVis);
      if (vis < 0.2) continue;  // hidden behind trees ~60% of the time

      const cow = fd.deer;
      const cx = Math.round(cow.homeX + Math.sin(timeMs * cow.freqX + cow.phaseX) * cow.radiusX);
      const cy = Math.round(cow.homeY + Math.sin(timeMs * cow.freqY + cow.phaseY) * cow.radiusY);

      const vx = Math.cos(timeMs * cow.freqX + cow.phaseX);
      const facingRight = cow.mirrorBase ? vx > 0 : vx <= 0;
      const sprite = facingRight ? DEER_RIGHT : DEER_LEFT;

      for (let row = 0; row < DEER_H; row++) {
        for (let col = 0; col < DEER_W; col++) {
          const cell = sprite[row][col];
          if (cell === _) continue;
          const px = cx + col;
          const py = cy + row;
          if (px < 0 || px >= N || py < 0 || py >= N) continue;

          const srcIdx = py * N + px;
          if (!fd.validPixels.has(srcIdx)) continue;

          const screenIdx = this._screenIdx(srcIdx, N, ext);
          if (screenIdx < 0) continue;

          pixels[screenIdx] = DEER_COLORS[cell];
          fd.dirtyScreen.push({ screenIdx, srcIdx });
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
