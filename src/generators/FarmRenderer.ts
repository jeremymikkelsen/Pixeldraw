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
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { AgImprovementType } from '../state/AgImprovements';

// ── Grain field palettes ──────────────────────────────────────────────────────
// Four colors per season: furrow, stalk base, stalk body, stalk tip

const G_FURROW = {
  [Season.Winter]: packABGR(0x2e, 0x1e, 0x10),
  [Season.Spring]: packABGR(0x38, 0x28, 0x16),
  [Season.Summer]: packABGR(0x28, 0x20, 0x10),
  [Season.Fall]: packABGR(0x38, 0x28, 0x10),
};
const G_BASE = {
  [Season.Winter]: packABGR(0x44, 0x30, 0x1c),
  [Season.Spring]: packABGR(0x2a, 0x4a, 0x18),
  [Season.Summer]: packABGR(0x3a, 0x50, 0x18),
  [Season.Fall]: packABGR(0x72, 0x42, 0x10),
};
const G_BODY = {
  [Season.Winter]: packABGR(0x50, 0x3c, 0x24),
  [Season.Spring]: packABGR(0x3a, 0x68, 0x28),
  [Season.Summer]: packABGR(0x5a, 0x78, 0x28),
  [Season.Fall]: packABGR(0xa0, 0x68, 0x20),
};
const G_TIP = {
  [Season.Winter]: packABGR(0x58, 0x46, 0x2c),
  [Season.Spring]: packABGR(0x58, 0xa0, 0x3c),
  [Season.Summer]: packABGR(0x88, 0xaa, 0x30),
  [Season.Fall]: packABGR(0xe0, 0xa8, 0x30),
};

// ── Veggie field palettes ─────────────────────────────────────────────────────

const VEGGIE_SOIL = {
  [Season.Winter]: packABGR(0x68, 0x58, 0x48),
  [Season.Spring]: packABGR(0x3d, 0x2b, 0x14),
  [Season.Summer]: packABGR(0x48, 0x34, 0x18),
  [Season.Fall]: packABGR(0x52, 0x3c, 0x20),
};

// 3 crop types × 4 seasons — each entry: [shadow, highlight]
// Type 0: Leafy greens (brassica/lettuce)
// Type 1: Root veg / carrot tops (wispy green → orange autumn)
// Type 2: Flowers / poppies (green → red)
const CROP: Record<number, Record<Season, [number, number]>> = {
  0: {
    [Season.Winter]: [packABGR(0x68, 0x58, 0x48), packABGR(0x68, 0x58, 0x48)],
    [Season.Spring]: [packABGR(0x22, 0x52, 0x20), packABGR(0x32, 0x78, 0x30)],
    [Season.Summer]: [packABGR(0x1c, 0x4a, 0x1c), packABGR(0x2e, 0x72, 0x2c)],
    [Season.Fall]: [packABGR(0x5a, 0x6c, 0x10), packABGR(0x80, 0x98, 0x20)],
  },
  1: {
    [Season.Winter]: [packABGR(0x68, 0x58, 0x48), packABGR(0x68, 0x58, 0x48)],
    [Season.Spring]: [packABGR(0x48, 0x78, 0x28), packABGR(0x68, 0xa0, 0x38)],
    [Season.Summer]: [packABGR(0x48, 0x78, 0x28), packABGR(0x68, 0xa0, 0x38)],
    [Season.Fall]: [packABGR(0x90, 0x40, 0x10), packABGR(0xd8, 0x70, 0x20)],
  },
  2: {
    [Season.Winter]: [packABGR(0x68, 0x58, 0x48), packABGR(0x68, 0x58, 0x48)],
    [Season.Spring]: [packABGR(0x28, 0x60, 0x20), packABGR(0x3a, 0x88, 0x28)],
    [Season.Summer]: [packABGR(0x80, 0x18, 0x12), packABGR(0xcc, 0x28, 0x18)],
    [Season.Fall]: [packABGR(0x78, 0x18, 0x10), packABGR(0xb8, 0x20, 0x14)],
  },
};

// ── Pasture palettes ──────────────────────────────────────────────────────────
const PASTURE_A = {
  [Season.Winter]: packABGR(0xc0, 0xc8, 0xb8),
  [Season.Spring]: packABGR(0x48, 0x78, 0x28),
  [Season.Summer]: packABGR(0x3e, 0x6c, 0x28),
  [Season.Fall]: packABGR(0x58, 0x62, 0x28),
};
const PASTURE_B = {
  [Season.Winter]: packABGR(0xd0, 0xd8, 0xc8),
  [Season.Spring]: packABGR(0x60, 0x9a, 0x38),
  [Season.Summer]: packABGR(0x52, 0x90, 0x38),
  [Season.Fall]: packABGR(0x4c, 0x72, 0x2c),
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
          const color = this._pasturePixel(px, py, season, noise);
          pixels[i] = color;
          pastureMap.get(r)!.interiorPixels.push({ idx: i, color });
          break;
        }
      }
    }
  }

  // ── Grain stalk pixel ───────────────────────────────────────────────────────
  private _grainPixel(px: number, py: number, m: RegionMeta, season: Season): number {
    // Project onto long axis (stalk column index) and perp axis (stalk height)
    const along = Math.floor(px * m.longX + py * m.longY);
    const perp  = Math.floor(px * m.perpX + py * m.perpY);

    const col = along % 3;  // 0,1 = stalk column; 2 = gap
    const row = perp  % 5;  // 0 = tip, 1,2 = body, 3 = base, 4 = furrow

    const isFurrow = col === 2 || row === 4;
    if (isFurrow) return G_FURROW[season];
    if (row === 3) return G_BASE[season];
    if (row > 0)  return G_BODY[season];
    return G_TIP[season];
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
    return n > 0.5 ? highlight : shadow;
  }

  // ── Pasture pixel ───────────────────────────────────────────────────────────
  private _pasturePixel(
    px: number, py: number,
    season: Season,
    noise: (x: number, y: number) => number,
  ): number {
    const n = (noise(px * 0.18, py * 0.18) + 1) / 2;
    return n > 0.5 ? PASTURE_B[season] : PASTURE_A[season];
  }
}
