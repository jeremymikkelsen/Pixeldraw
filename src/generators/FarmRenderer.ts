/**
 * FarmRenderer — renders grain fields, veggie fields, and cow pastures
 * onto the pixel buffer in a single pass over regionGrid.
 *
 * Grain fields: 3/4-perspective stalk columns oriented along the region's
 * long axis. Stalks are 2px wide × 3px tall with a 2px furrow gap between rows.
 *
 * Veggie fields: tilled soil with 2-3 crop patches, each filled with an
 * organic dot pattern using noise.
 *
 * Pastures: worn/patchy grass. Cow animation is handled by PastureAnimator.
 * Interior pixels are captured here for per-frame cow erasure.
 */

import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { packABGR, applyBrightness } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { AgImprovementType } from '../state/AgImprovements';

const GRAIN_BRIGHTNESS = 1.25;
const VEGGIE_BRIGHTNESS = 1.25;

// ── Veggie field palettes ─────────────────────────────────────────────────────

const VEGGIE_SOIL = {
  [Season.Winter]: packABGR(0x68, 0x58, 0x48),
  [Season.Spring]: packABGR(0x3d, 0x2b, 0x14),
  [Season.Summer]: packABGR(0x48, 0x34, 0x18),
  [Season.Fall]: packABGR(0x52, 0x3c, 0x20),
};

// 3 crop types × 4 seasons — each entry: [shadow, highlight] (RGB hex)
// Type 0: Leafy greens (brassica/lettuce)
// Type 1: Root veg / carrot tops (wispy green → orange autumn)
// Type 2: Flowers / poppies (green → red)
const CROP: Record<number, Record<Season, [number, number]>> = {
  0: {
    [Season.Winter]: [0x685848, 0x685848],
    [Season.Spring]: [0x225220, 0x327830],
    [Season.Summer]: [0x1c4a1c, 0x2e722c],
    [Season.Fall]: [0x5a6c10, 0x809820],
  },
  1: {
    [Season.Winter]: [0x685848, 0x685848],
    [Season.Spring]: [0x487828, 0x68a038],
    [Season.Summer]: [0x487828, 0x68a038],
    [Season.Fall]: [0x904010, 0xd87020],
  },
  2: {
    [Season.Winter]: [0x685848, 0x685848],
    [Season.Spring]: [0x286020, 0x3a8828],
    [Season.Summer]: [0x801812, 0xcc2818],
    [Season.Fall]: [0x781810, 0xb82014],
  },
};

// ── Pasture palettes ──────────────────────────────────────────────────────────
// A and B are kept close together so the noise variation reads as a uniform
// green field rather than a blotchy two-tone pattern.
// Pasture colors (RGB hex — applyBrightness converts to ABGR)
const PASTURE_A = {
  [Season.Winter]: 0xb8c4b0,
  [Season.Spring]: 0x528a2e,
  [Season.Summer]: 0x467c28,
  [Season.Fall]:   0x586e28,
};
const PASTURE_B = {
  [Season.Winter]: 0xc4d0bc,
  [Season.Spring]: 0x5c9834,
  [Season.Summer]: 0x508a2e,
  [Season.Fall]:   0x627a2c,
};

// ── RegionMeta: axis info per improvement region ──────────────────────────────
interface RegionMeta {
  minX: number; maxX: number; minY: number; maxY: number;
  // Long-axis unit vector (direction of rows in grain/veggie)
  longX: number; longY: number;
  // Perp unit vector (stalk growth direction)
  perpX: number; perpY: number;
}

// ── Public output ─────────────────────────────────────────────────────────────
export interface PastureData {
  regionIndex: number;
  minX: number; maxX: number; minY: number; maxY: number;
  interiorPixels: { idx: number; color: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
export class FarmRenderer {
  farmMask: Uint8Array | null = null;
  pastures: PastureData[] = [];

  render(
    pixels: Uint32Array,
    N: number,
    improvements: Map<number, AgImprovementType>,
    topo: TopographyGenerator,
    regionGrid: Uint16Array,
    seed: number,
    season: Season,
  ): void {
    if (improvements.size === 0) return;

    const rngNoise = mulberry32(seed ^ 0xfa4a01);
    const noise = createNoise2D(rngNoise);

    // Per-region PCA accumulators
    const regionIds = new Set(improvements.keys());
    const stats = new Map<number, {
      sx: number; sy: number; sxx: number; syy: number; sxy: number; n: number;
      minX: number; maxX: number; minY: number; maxY: number;
    }>();
    for (const r of regionIds) {
      stats.set(r, { sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, n: 0,
        minX: N, maxX: 0, minY: N, maxY: 0 });
    }

    // Pass 1: accumulate pixel statistics per region
    for (let i = 0; i < N * N; i++) {
      const r = regionGrid[i];
      const s = stats.get(r);
      if (!s) continue;
      const px = i % N;
      const py = (i - px) / N;
      s.sx += px; s.sy += py;
      s.sxx += px * px; s.syy += py * py; s.sxy += px * py;
      s.n++;
      if (px < s.minX) s.minX = px;
      if (px > s.maxX) s.maxX = px;
      if (py < s.minY) s.minY = py;
      if (py > s.maxY) s.maxY = py;
    }

    // Compute PCA long axis and perpendicular for each region
    const meta = new Map<number, RegionMeta>();
    const veggieCrops = new Map<number, [number, number, number]>();

    for (const [r, s] of stats) {
      if (s.n === 0) continue;
      const cx = s.sx / s.n;
      const cy = s.sy / s.n;
      const cxx = s.sxx / s.n - cx * cx;
      const cyy = s.syy / s.n - cy * cy;
      const cxy = s.sxy / s.n - cx * cy;

      // Eigenvector of larger eigenvalue of [[cxx, cxy], [cxy, cyy]]
      let lx: number, ly: number;
      if (Math.abs(cxy) > 1e-6) {
        const diff = cxx - cyy;
        const disc = Math.sqrt(diff * diff + 4 * cxy * cxy);
        const lambda = ((cxx + cyy) + disc) / 2;
        lx = lambda - cyy;
        ly = cxy;
      } else if (cxx >= cyy) {
        lx = 1; ly = 0;
      } else {
        lx = 0; ly = 1;
      }
      const len = Math.sqrt(lx * lx + ly * ly) || 1;
      lx /= len; ly /= len;

      meta.set(r, {
        minX: s.minX, maxX: s.maxX, minY: s.minY, maxY: s.maxY,
        longX: lx, longY: ly,
        perpX: -ly, perpY: lx,
      });

      if (improvements.get(r) === 'veggie') {
        const rng2 = mulberry32(seed ^ (r * 0xa3b4c5));
        const types: number[] = [0, 1, 2];
        [types[0], types[Math.floor(rng2() * 3)]] = [types[Math.floor(rng2() * 3)], types[0]];
        veggieCrops.set(r, [types[0], types[1], types[2]]);
      }
    }

    // Allocate mask
    this.farmMask = new Uint8Array(N * N);
    this.pastures = [];
    const pastureMap = new Map<number, PastureData>();

    // Pre-create pasture data objects
    for (const [r, type] of improvements) {
      if (type === 'pasture') {
        const m = meta.get(r)!;
        const pd: PastureData = {
          regionIndex: r,
          minX: m.minX, maxX: m.maxX, minY: m.minY, maxY: m.maxY,
          interiorPixels: [],
        };
        this.pastures.push(pd);
        pastureMap.set(r, pd);
      }
    }

    // Pass 2: render
    for (let i = 0; i < N * N; i++) {
      const r = regionGrid[i];
      const type = improvements.get(r);
      if (!type) continue;

      const m = meta.get(r)!;
      const px = i % N;
      const py = (i - px) / N;
      this.farmMask![i] = 1;

      switch (type) {
        case 'grain':
          pixels[i] = this._grainPixel(px, py, m, season, noise);
          break;
        case 'veggie': {
          const crops = veggieCrops.get(r)!;
          pixels[i] = this._veggiePixel(px, py, m, crops, season, noise);
          break;
        }
        case 'pasture': {
          const color = this._pasturePixel(px, py, season, noise);
          pixels[i] = color;
          pastureMap.get(r)!.interiorPixels.push({ idx: i, color });
          break;
        }
      }
    }

  }

  // ── Grain stalk pixel — seasonal patterns ───────────────────────────────────
  private _grainPixel(
    px: number, py: number, m: RegionMeta, season: Season,
    noise: (x: number, y: number) => number,
  ): number {
    const perp = px * m.perpX + py * m.perpY;
    const along = px * m.longX + py * m.longY;

    // ── Winter: bare brown soil + snow patches + dark stubble ──
    if (season === Season.Winter) {
      const n1 = noise(px * 0.06, py * 0.06);
      const n2 = noise(px * 0.18 + 50, py * 0.18 + 50);
      if (n1 > 0.25) {
        // Snow patch
        return applyBrightness(n1 > 0.5 ? 0xdce4ec : 0xc4d0dc, 0.95 + n2 * 0.08);
      }
      if (n2 > 0.65) {
        // Dark stubble / cracks
        return applyBrightness(0x30201a, 1.0);
      }
      return applyBrightness(n2 > 0 ? 0x685040 : 0x584030, 1.0);
    }

    // ── Spring: brown soil with small green sprout clusters ──
    if (season === Season.Spring) {
      const gp = ((Math.floor(perp) % 5) + 5) % 5;
      const ga = ((Math.floor(along) % 5) + 5) % 5;
      // 2x2 sprout in each 5×5 cell
      if (gp >= 1 && gp <= 2 && ga >= 1 && ga <= 2) {
        const n = noise(px * 0.25, py * 0.25);
        return applyBrightness(n > 0 ? 0x78b830 : 0x4a8020, GRAIN_BRIGHTNESS);
      }
      const sn = noise(px * 0.12, py * 0.12);
      return applyBrightness(sn > 0 ? 0x6a4c2c : 0x5a3c20, 1.0);
    }

    // ── Summer: dense green rows, thin furrow ──
    if (season === Season.Summer) {
      const row = ((Math.floor(perp) % 4) + 4) % 4;
      if (row === 0) return applyBrightness(0x2a3818, 1.0);
      const n = noise(px * 0.2, py * 0.2);
      if (row === 1) return applyBrightness(0x3a5818, GRAIN_BRIGHTNESS);
      if (row === 2) return applyBrightness(n > 0 ? 0x5a9830 : 0x4a8828, GRAIN_BRIGHTNESS);
      return applyBrightness(n > 0 ? 0x88b838 : 0x70a030, GRAIN_BRIGHTNESS);
    }

    // ── Fall: dense golden wheat rows ──
    const row = ((Math.floor(perp) % 4) + 4) % 4;
    if (row === 0) return applyBrightness(0x8a6820, 1.0);
    const n = noise(px * 0.2, py * 0.2);
    if (row === 1) return applyBrightness(n > 0 ? 0xb88828 : 0xa07820, GRAIN_BRIGHTNESS);
    if (row === 2) return applyBrightness(n > 0 ? 0xd8a838 : 0xc89830, GRAIN_BRIGHTNESS);
    return applyBrightness(n > 0 ? 0xf0cc50 : 0xe8c040, GRAIN_BRIGHTNESS);
  }

  // ── Veggie patch pixel ──────────────────────────────────────────────────────
  private _veggiePixel(
    px: number, py: number,
    m: RegionMeta,
    crops: [number, number, number],
    season: Season,
    noise: (x: number, y: number) => number,
  ): number {
    // Divide bbox into 3 horizontal (or vertical) strips
    const W = m.maxX - m.minX || 1;
    const H = m.maxY - m.minY || 1;
    const isHoriz = W >= H;

    let stripIdx: number;
    if (isHoriz) {
      const relX = (px - m.minX) / W;
      stripIdx = relX < 0.38 ? 0 : relX < 0.68 ? 1 : 2;
    } else {
      const relY = (py - m.minY) / H;
      stripIdx = relY < 0.38 ? 0 : relY < 0.68 ? 1 : 2;
    }

    const cropType = crops[stripIdx];
    const soil = VEGGIE_SOIL[season];

    if (season === Season.Winter) return soil;

    // Dot pattern: plant appears at regular intervals
    // Different offsets per crop type to break monotony
    const dotX = (px + cropType * 3) % 4;
    const dotY = (py + cropType * 2) % 4;
    const isDot = dotX < 2 && dotY < 2;

    if (!isDot) return soil;

    // Noise for shade variation within dots
    const n = (noise(px * 0.3, py * 0.3) + 1) / 2;
    const [shadow, highlight] = CROP[cropType][season];
    return applyBrightness(n > 0.5 ? highlight : shadow, VEGGIE_BRIGHTNESS);
  }

  // ── Pasture pixel ───────────────────────────────────────────────────────────
  private _pasturePixel(
    px: number, py: number,
    season: Season,
    noise: (x: number, y: number) => number,
  ): number {
    const n = (noise(px * 0.18, py * 0.18) + 1) / 2;
    const base = n > 0.5 ? PASTURE_B[season] : PASTURE_A[season];
    return applyBrightness(base, 1.0);
  }

}
