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

const GRAIN_BRIGHTNESS = 1.35;
const VEGGIE_BRIGHTNESS = 1.25;

// ── Grain field palettes (RGB hex — applyBrightness converts to ABGR) ───────
// Four colors per season: furrow, stalk base, stalk body, stalk tip

const G_FURROW = {
  [Season.Winter]: 0x2e1e10,
  [Season.Spring]: 0x382816,
  [Season.Summer]: 0x282010,
  [Season.Fall]: 0x382810,
};
const G_BASE = {
  [Season.Winter]: 0x44301c,
  [Season.Spring]: 0x2a4a18,
  [Season.Summer]: 0x3a5018,
  [Season.Fall]: 0x8a6818,
};
const G_BODY = {
  [Season.Winter]: 0x503c24,
  [Season.Spring]: 0x3a6828,
  [Season.Summer]: 0x5a7828,
  [Season.Fall]: 0xc89828,
};
const G_TIP = {
  [Season.Winter]: 0x58462c,
  [Season.Spring]: 0x58a03c,
  [Season.Summer]: 0x88aa30,
  [Season.Fall]: 0xe8c040,
};

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

    // Per-region metadata + crop assignment
    const meta = new Map<number, RegionMeta>();
    const veggieCrops = new Map<number, [number, number, number]>(); // region → [cropA, cropB, cropC]

    for (const r of improvements.keys()) {
      meta.set(r, { minX: N, maxX: 0, minY: N, maxY: 0, longX: 1, longY: 0, perpX: 0, perpY: 1 });
    }

    // Pass 1: build bounding boxes
    for (let i = 0; i < N * N; i++) {
      const r = regionGrid[i];
      const m = meta.get(r);
      if (!m) continue;
      const px = i % N;
      const py = (i - px) / N;
      if (px < m.minX) m.minX = px;
      if (px > m.maxX) m.maxX = px;
      if (py < m.minY) m.minY = py;
      if (py > m.maxY) m.maxY = py;
    }

    // Compute axes and veggie crop assignments
    for (const [r, m] of meta) {
      const W = m.maxX - m.minX;
      const H = m.maxY - m.minY;
      if (W >= H) {
        // Long axis horizontal → rows run left-right, stalks grow up (along -Y)
        m.longX = 1; m.longY = 0;
        m.perpX = 0; m.perpY = 1;
      } else {
        // Long axis vertical → rows run top-bottom, stalks grow right (along X)
        m.longX = 0; m.longY = 1;
        m.perpX = 1; m.perpY = 0;
      }

      if (improvements.get(r) === 'veggie') {
        const rng = mulberry32(seed ^ (r * 0xa3b4c5));
        const types: number[] = [0, 1, 2];
        // Shuffle
        [types[0], types[Math.floor(rng() * 3)]] = [types[Math.floor(rng() * 3)], types[0]];
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
          pixels[i] = this._grainPixel(px, py, m, season);
          break;
        case 'veggie': {
          const crops = veggieCrops.get(r)!;
          pixels[i] = this._veggiePixel(px, py, m, crops, season, noise);
          break;
        }
        case 'pasture': {
          const color = this._pasturePixel(px, py, season, noise, pixels[i]);
          pixels[i] = color;
          pastureMap.get(r)!.interiorPixels.push({ idx: i, color });
          break;
        }
      }
    }

  }

  // ── Grain stalk pixel ───────────────────────────────────────────────────────
  private _grainPixel(px: number, py: number, m: RegionMeta, season: Season): number {
    // Project onto perpendicular axis (across rows) — rows run along the long axis
    const perp = Math.floor(px * m.perpX + py * m.perpY);

    // Period 5: 1px furrow + 4px of wheat (base, body, body, tip)
    const row = ((perp % 5) + 5) % 5;

    if (row === 0) return applyBrightness(G_FURROW[season], 1.0);

    const base = row === 1 ? G_BASE[season]
      : row <= 3 ? G_BODY[season]
      : G_TIP[season];
    return applyBrightness(base, GRAIN_BRIGHTNESS);
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
    terrainPx: number,
  ): number {
    const n = (noise(px * 0.18, py * 0.18) + 1) / 2;
    const base = n > 0.5 ? PASTURE_B[season] : PASTURE_A[season];

    // Scale pasture color to match terrain slope shading so pastures don't
    // appear uniformly bright against shaded surroundings.
    const tr = terrainPx & 0xFF;
    const tg = (terrainPx >> 8) & 0xFF;
    const tb = (terrainPx >> 16) & 0xFF;
    // Rec.601 luminance (integer arithmetic)
    const lum = (tr * 77 + tg * 150 + tb * 29) >> 8;
    // Expected neutral lowland lum for flat mid-lit terrain (~middle lowland shade)
    const neutralLum = 95;
    const scale = Math.max(0.5, Math.min(1.3, lum / neutralLum));
    return applyBrightness(base, scale);
  }

}
