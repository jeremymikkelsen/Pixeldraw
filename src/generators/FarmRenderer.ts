/**
 * FarmRenderer — renders grain fields, gardens, and cow pastures
 * onto the pixel buffer in a single pass over regionGrid.
 *
 * Grain fields: 3/4-perspective stalk columns oriented along the region's
 * long axis. Stalks are 2px wide × 3px tall with a 2px furrow gap between rows.
 *
 * Gardens: tilled soil with 2-3 crop patches, each filled with an
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

// ── Garden palettes ───────────────────────────────────────────────────────────

const VEGGIE_SOIL = {
  [Season.Winter]: packABGR(0x68, 0x58, 0x48),
  [Season.Spring]: packABGR(0x3d, 0x2b, 0x14),
  [Season.Summer]: packABGR(0x48, 0x34, 0x18),
  [Season.Fall]: packABGR(0x52, 0x3c, 0x20),
};

// ── Dirt path color — worn earth at field/garden cell boundaries ──────────────
const DIRT_PATH_COLOR = {
  [Season.Winter]: packABGR(0x7a, 0x6a, 0x5a),
  [Season.Spring]: packABGR(0x56, 0x3c, 0x20),
  [Season.Summer]: packABGR(0x50, 0x38, 0x1c),
  [Season.Fall]:   packABGR(0x5c, 0x40, 0x22),
};

// Per-crop-type leaf color pairs (shadow, highlight) — Spring and Summer
// Fall/Winter use inline values for vines/snow
const LEAF_SPRING: [number, number][] = [
  [0x2a5c18, 0x3e8026],  // 0: leafy greens
  [0x3a7020, 0x509430],  // 1: root-veg tops
  [0x266018, 0x3a8828],  // 2: broad-leaf
];
const LEAF_SUMMER: [number, number][] = [
  [0x1e5a18, 0x389030],  // 0: dark lush
  [0x3a7820, 0x58a030],  // 1: medium green
  [0x286820, 0x4a9428],  // 2: rich green
];

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
  // Long-axis unit vector (direction of rows in grain/garden)
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

export interface GardenData {
  regionIndex: number;
  minX: number; maxX: number; minY: number; maxY: number;
}

// ─────────────────────────────────────────────────────────────────────────────
export class FarmRenderer {
  farmMask: Uint8Array | null = null;
  pastures: PastureData[] = [];
  gardens: GardenData[] = [];

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
    const gardenCrops = new Map<number, [number, number, number]>();

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

      if (improvements.get(r) === 'garden') {
        const rng2 = mulberry32(seed ^ (r * 0xa3b4c5));
        const types: number[] = [0, 1, 2];
        [types[0], types[Math.floor(rng2() * 3)]] = [types[Math.floor(rng2() * 3)], types[0]];
        gardenCrops.set(r, [types[0], types[1], types[2]]);
      }
    }

    // Precompute pumpkin centers for fall garden regions (2–3 per region)
    const gardenPumpkins = new Map<number, { cx: number; cy: number }[]>();
    if (season === Season.Fall) {
      for (const [r, m] of meta) {
        if (improvements.get(r) !== 'garden') continue;
        const rng3 = mulberry32(seed ^ (r * 0xb7c3d5) ^ 0xf00d);
        const count = 2 + (rng3() > 0.5 ? 1 : 0);
        const W = m.maxX - m.minX;
        const H = m.maxY - m.minY;
        const centers: { cx: number; cy: number }[] = [];
        for (let k = 0; k < count; k++) {
          centers.push({
            cx: Math.round(m.minX + (0.15 + rng3() * 0.70) * W),
            cy: Math.round(m.minY + (0.15 + rng3() * 0.70) * H),
          });
        }
        gardenPumpkins.set(r, centers);
      }
    }

    // Allocate mask
    this.farmMask = new Uint8Array(N * N);
    this.pastures = [];
    this.gardens = [];
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

    // Pre-create garden data objects
    for (const [r, type] of improvements) {
      if (type === 'garden') {
        const m = meta.get(r);
        if (!m) continue;
        this.gardens.push({
          regionIndex: r,
          minX: m.minX, maxX: m.maxX, minY: m.minY, maxY: m.maxY,
        });
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

      // 1-px dirt path at Voronoi cell boundaries (grain and garden only, not pasture)
      if (type !== 'pasture') {
        const isBoundary =
          (px > 0 && regionGrid[i - 1] !== r) ||
          (px < N - 1 && regionGrid[i + 1] !== r) ||
          (py > 0 && regionGrid[i - N] !== r) ||
          (py < N - 1 && regionGrid[i + N] !== r);
        if (isBoundary) {
          pixels[i] = DIRT_PATH_COLOR[season];
          continue;
        }
      }

      switch (type) {
        case 'grain':
          pixels[i] = this._grainPixel(px, py, m, season, noise);
          break;
        case 'garden': {
          const crops = gardenCrops.get(r)!;
          const pumpkins = gardenPumpkins.get(r);
          pixels[i] = this._veggiePixel(px, py, m, crops, season, noise, pumpkins);
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
      // 1×2 sprout (1 wide, 2 tall) in each 5×5 cell
      if (gp >= 1 && gp <= 2 && ga === 2) {
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

  // ── Garden patch pixel ──────────────────────────────────────────────────────
  private _veggiePixel(
    px: number, py: number,
    m: RegionMeta,
    crops: [number, number, number],
    season: Season,
    noise: (x: number, y: number) => number,
    pumpkins?: { cx: number; cy: number }[],
  ): number {
    // Divide bbox into 3 strips, boundaries blurred by low-freq noise
    const W = m.maxX - m.minX || 1;
    const H = m.maxY - m.minY || 1;
    const isHoriz = W >= H;
    const stripBlur = noise(px * 0.08, py * 0.08) * 0.07;

    let stripIdx: number;
    if (isHoriz) {
      const rel = (px - m.minX) / W + stripBlur;
      stripIdx = rel < 0.38 ? 0 : rel < 0.68 ? 1 : 2;
    } else {
      const rel = (py - m.minY) / H + stripBlur;
      stripIdx = rel < 0.38 ? 0 : rel < 0.68 ? 1 : 2;
    }

    const cropType = crops[stripIdx];
    const soil = VEGGIE_SOIL[season];

    // ── Winter: snow mounds + bare stems ────────────────────────────────────
    if (season === Season.Winter) {
      const snowN = noise(px * 0.28 + 100, py * 0.28);
      if (snowN > 0.20) {
        const sn2 = noise(px * 0.55 + 200, py * 0.55);
        return applyBrightness(sn2 > 0 ? 0xdce8f0 : 0xc8d8e8, 1.0);
      }
      // Rare bare stem pixel
      if (noise(px * 0.9 + 50, py * 0.9 + 50) > 0.82) {
        return applyBrightness(0x3c2a18, 1.0);
      }
      return soil;
    }

    // ── Fall: vine tendrils + leaf clusters + pumpkins ──────────────────────
    if (season === Season.Fall) {
      // Pumpkins: radius-2 blobs at precomputed centers
      if (pumpkins) {
        for (const { cx, cy } of pumpkins) {
          const dx = px - cx, dy = py - cy;
          if (dx * dx + dy * dy <= 1) {
            return applyBrightness(dy < 0 ? 0xc05810 : 0xe07018, 1.0);
          }
        }
      }
      // Vine tendril: thin isoline of medium-freq noise
      const vineN = noise(px * 0.22 + cropType * 5.3, py * 0.22);
      const isVine = Math.abs(vineN) < 0.12;
      // Leaf blob: small high-freq clusters
      const leafN = noise(px * 0.46 + cropType * 3.7, py * 0.46);
      const isLeaf = leafN > 0.30;
      if (isVine || isLeaf) {
        // Red accent (~4% of plant pixels, summer+fall only)
        if (noise(px * 1.8 + 31, py * 1.8 + 31) > 0.84) {
          return applyBrightness(0x981410, 1.0);
        }
        const shade = noise(px * 0.75 + 5, py * 0.75);
        return applyBrightness(shade > 0.1 ? 0x3a6c18 : 0x285010, 1.0);
      }
      return soil;
    }

    // ── Spring: dense small organic leaf clusters ────────────────────────────
    if (season === Season.Spring) {
      const plantN = noise(px * 0.47 + cropType * 4.1, py * 0.47);
      if (plantN > 0.04) {
        const shade = noise(px * 0.82 + 11, py * 0.82 + 11);
        const [shadow, highlight] = LEAF_SPRING[cropType];
        return applyBrightness(shade > 0.15 ? highlight : shadow, 1.0);
      }
      return soil;
    }

    // ── Summer: lush larger blobs + red accents ──────────────────────────────
    const plantN = noise(px * 0.38 + cropType * 3.9, py * 0.38);
    if (plantN > -0.06) {
      // Red accent (~4% of plant pixels)
      if (noise(px * 1.7 + 22, py * 1.7 + 22) > 0.84) {
        return applyBrightness(0x8c1210, 1.0);
      }
      const shade = noise(px * 0.72 + 17, py * 0.72);
      const [shadow, highlight] = LEAF_SUMMER[cropType];
      return applyBrightness(shade > 0.15 ? highlight : shadow, 1.0);
    }
    return soil;
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
