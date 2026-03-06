/**
 * StructureRenderer — places thatched-roof cottages on lowland/highland regions.
 *
 * Each duchy capital gets a larger manor; other eligible regions may get
 * small cottages based on density heuristics (moisture, elevation, proximity
 * to rivers).
 *
 * Sprites are stamped into the shared pixel buffer using the same painter's
 * algorithm (north→south) as TreeRenderer.  Returns a structureMask so that
 * downstream renderers (trees, mountains) can avoid overwriting buildings.
 */

import PoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { Duchy } from '../state/Duchy';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;
const SHADOW_OFFSET_X = 2;
const SHADOW_OFFSET_Y = 1;
const SHADOW_DARKEN = 0.50;
const EDGE_MARGIN = 12;
const RIVER_BUFFER = 8;        // keep buildings further from rivers than trees
const MIN_COTTAGE_SPACING = 28; // pixel-space min distance between structures
const MAX_COTTAGE_SPACING = 50;
const COTTAGE_DENSITY = 0.12;   // base probability a candidate gets a building

// Terrain suitability
const MAX_BUILDING_ELEVATION = 0.38;  // no cottages above this
const MIN_BUILDING_ELEVATION = 0.10;  // no cottages below (water/coast)

// ---------------------------------------------------------------------------
// Pixel cell types
// ---------------------------------------------------------------------------
const _ = 0;  // transparent
const W = 1;  // wall (wood)
const R = 2;  // roof (thatch)
const D = 3;  // door
const S = 4;  // stone foundation
const N = 5;  // window
const P = 6;  // porch / wooden platform
const K = 7;  // chimney

// ---------------------------------------------------------------------------
// Sprite templates
// ---------------------------------------------------------------------------
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

// Small cottage (9×10) — simple thatched hut with door
const COTTAGE_SMALL: SpriteTemplate = {
  w: 9, h: 10, anchorY: 9, data: [
    _, _, _, K, R, R, _, _, _,
    _, _, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, _,
    _, R, R, R, R, R, R, R, _,
    _, S, W, W, N, W, W, S, _,
    _, S, W, W, W, W, W, S, _,
    _, S, W, W, D, W, W, S, _,
    _, S, S, S, S, S, S, S, _,
    _, _, P, P, P, P, P, _, _,
    _, _, _, P, P, P, _, _, _,
  ],
};

// Medium cottage (11×12) — with porch and chimney
const COTTAGE_MEDIUM: SpriteTemplate = {
  w: 11, h: 12, anchorY: 11, data: [
    _, _, _, _, K, R, R, _, _, _, _,
    _, _, _, R, R, R, R, R, _, _, _,
    _, _, R, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, R, R, _,
    _, R, R, R, R, R, R, R, R, R, _,
    _, S, W, W, N, W, N, W, W, S, _,
    _, S, W, W, W, W, W, W, W, S, _,
    _, S, W, W, W, D, W, W, W, S, _,
    _, S, S, S, S, S, S, S, S, S, _,
    _, _, P, P, P, P, P, P, P, _, _,
    _, _, _, P, P, P, P, P, _, _, _,
    _, _, _, _, P, P, P, _, _, _, _,
  ],
};

// Manor house (15×16) — larger estate for duchy capitals
const MANOR: SpriteTemplate = {
  w: 15, h: 16, anchorY: 15, data: [
    _, _, _, _, _, K, R, R, R, K, _, _, _, _, _,
    _, _, _, _, R, R, R, R, R, R, R, _, _, _, _,
    _, _, _, R, R, R, R, R, R, R, R, R, _, _, _,
    _, _, R, R, R, R, R, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, R, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, R, _,
    _, S, W, W, N, W, W, N, W, W, N, W, W, S, _,
    _, S, W, W, W, W, W, W, W, W, W, W, W, S, _,
    _, S, W, W, W, W, W, W, W, W, W, W, W, S, _,
    _, S, W, W, N, W, W, D, W, W, N, W, W, S, _,
    _, S, S, S, S, S, S, S, S, S, S, S, S, S, _,
    _, _, P, P, P, P, P, P, P, P, P, P, P, _, _,
    _, _, _, P, P, P, P, P, P, P, P, P, _, _, _,
    _, _, _, _, P, P, P, P, P, P, P, _, _, _, _,
    _, _, _, _, _, P, P, P, P, P, _, _, _, _, _,
    _, _, _, _, _, _, P, P, P, _, _, _, _, _, _,
  ],
};

const COTTAGE_TEMPLATES: SpriteTemplate[] = [COTTAGE_SMALL, COTTAGE_MEDIUM];

// ---------------------------------------------------------------------------
// Color palettes per cell type (RGB hex, 5 shades dark→light for directional lighting)
// ---------------------------------------------------------------------------
interface StructurePalette {
  wall: number[];     // 5 shades
  roof: number[];     // 5 shades
  stone: number[];    // 5 shades
  door: number;       // single color
  window: number;     // single color
  porch: number[];    // 3 shades
  chimney: number[];  // 3 shades
}

const PALETTE_SUMMER: StructurePalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340, 0x806248, 0x927150],
  roof:    [0x8a7a40, 0x9c8c50, 0xae9e60, 0xc0ae70, 0xd0be80],
  stone:   [0x585050, 0x686060, 0x787070, 0x888080, 0x989090],
  door:    0x3a2810,
  window:  0x4488bb,
  porch:   [0x5a4830, 0x6e5c3e, 0x82704c],
  chimney: [0x504848, 0x605858, 0x706868],
};

const PALETTE_WINTER: StructurePalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340, 0x806248, 0x927150],
  roof:    [0xc8c8d0, 0xd4d4dc, 0xe0e0e8, 0xeaeaf0, 0xf4f4f8], // snow-covered
  stone:   [0x585058, 0x686068, 0x787078, 0x888088, 0x989098],
  door:    0x3a2810,
  window:  0x3a78a8,
  porch:   [0xb0b0b8, 0xc0c0c8, 0xd0d0d8], // snow-covered
  chimney: [0x504848, 0x605858, 0x706868],
};

const PALETTE_SPRING: StructurePalette = { ...PALETTE_SUMMER };
const PALETTE_FALL: StructurePalette = {
  ...PALETTE_SUMMER,
  roof: [0x7a6a30, 0x8c7c40, 0x9e8e50, 0xb09e58, 0xc0ae60], // slightly duller thatch
};

function getPalette(season: Season): StructurePalette {
  switch (season) {
    case Season.Winter: return PALETTE_WINTER;
    case Season.Spring: return PALETTE_SPRING;
    case Season.Fall:   return PALETTE_FALL;
    default:            return PALETTE_SUMMER;
  }
}

// ---------------------------------------------------------------------------
// Structure instance
// ---------------------------------------------------------------------------
interface StructureInstance {
  px: number;         // pixel x of anchor (center-bottom)
  py: number;         // pixel y of anchor (bottom)
  template: SpriteTemplate;
  flipped: boolean;
  isCapital: boolean;
}

// ---------------------------------------------------------------------------
// StructureRenderer
// ---------------------------------------------------------------------------
export class StructureRenderer {

  renderStructures(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
    duchies: Duchy[],
    regionToDuchy: Int8Array,
    season: Season = Season.Summer,
  ): Uint8Array {
    const rng = mulberry32(seed ^ 0xBEEF0042);
    const res = resolution;
    const scale = topo.size / res;
    const { points } = topo.mesh;
    const numRegions = topo.mesh.numRegions;

    // ------------------------------------------------------------------
    // 1. Spatial grid for nearest-region lookup
    // ------------------------------------------------------------------
    const cellSize = 80;
    const gridW = Math.ceil(topo.size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) grid[gy * gridW + gx].push(r);
    }

    // ------------------------------------------------------------------
    // 2. Build river exclusion mask
    // ------------------------------------------------------------------
    const riverMask = this._buildRiverMask(topo, hydro, res);

    // ------------------------------------------------------------------
    // 3. Place capital manors at each duchy's capital region
    // ------------------------------------------------------------------
    const structures: StructureInstance[] = [];
    const palette = getPalette(season);

    for (const duchy of duchies) {
      const cr = duchy.capitalRegion;
      if (cr < 0 || cr >= numRegions) continue;

      const px = Math.floor(points[cr].x / scale);
      const py = Math.floor(points[cr].y / scale);

      if (px < EDGE_MARGIN || py < EDGE_MARGIN ||
          px >= res - EDGE_MARGIN || py >= res - EDGE_MARGIN) continue;

      structures.push({
        px,
        py,
        template: MANOR,
        flipped: false,
        isCapital: true,
      });
    }

    // ------------------------------------------------------------------
    // 4. Poisson disk sampling for village cottages
    // ------------------------------------------------------------------
    const pds = new PoissonDiskSampling({
      shape: [res, res],
      minDistance: MIN_COTTAGE_SPACING,
      maxDistance: MAX_COTTAGE_SPACING,
      tries: 20,
    }, rng);
    const candidates = pds.fill();

    for (const pt of candidates) {
      const px = Math.floor(pt[0]);
      const py = Math.floor(pt[1]);

      // Edge check
      if (px < EDGE_MARGIN || py < EDGE_MARGIN ||
          px >= res - EDGE_MARGIN || py >= res - EDGE_MARGIN) continue;

      // River avoidance
      if (riverMask[py * res + px]) continue;

      // Find nearest region
      const wx = px * scale;
      const wy = py * scale;
      const gx = Math.floor(wx / cellSize);
      const gy = Math.floor(wy / cellSize);
      let bestR = -1;
      let bestD2 = Infinity;
      for (let dy = -2; dy <= 2; dy++) {
        const row = gy + dy;
        if (row < 0 || row >= gridW) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const col = gx + dx;
          if (col < 0 || col >= gridW) continue;
          for (const r of grid[row * gridW + col]) {
            const d2 = (points[r].x - wx) ** 2 + (points[r].y - wy) ** 2;
            if (d2 < bestD2) { bestD2 = d2; bestR = r; }
          }
        }
      }
      if (bestR < 0) continue;

      // Terrain suitability
      const elev = topo.elevation[bestR];
      const terrain = topo.terrainType[bestR];
      if (elev < MIN_BUILDING_ELEVATION || elev > MAX_BUILDING_ELEVATION) continue;
      if (terrain !== 'lowland' && terrain !== 'highland' && terrain !== 'coast') continue;

      // Must belong to a duchy
      if (regionToDuchy[bestR] < 0) continue;

      // Skip if too close to a capital (capital already has a manor)
      let tooCloseToCapital = false;
      for (const s of structures) {
        if (!s.isCapital) continue;
        const d2 = (px - s.px) ** 2 + (py - s.py) ** 2;
        if (d2 < 20 * 20) { tooCloseToCapital = true; break; }
      }
      if (tooCloseToCapital) continue;

      // Density check — more cottages near rivers (moisture) and on flat lowland
      const moisture = hydro.moisture[bestR];
      let keepChance = COTTAGE_DENSITY;
      if (terrain === 'lowland') keepChance *= 1.5;
      if (moisture > 0.4) keepChance *= 1.4;
      if (rng() > keepChance) continue;

      // Pick template
      const templateIdx = rng() < 0.6 ? 0 : 1;

      structures.push({
        px,
        py,
        template: COTTAGE_TEMPLATES[templateIdx],
        flipped: rng() < 0.5,
        isCapital: false,
      });
    }

    // ------------------------------------------------------------------
    // 5. Sort by Y for painter's algorithm
    // ------------------------------------------------------------------
    structures.sort((a, b) => a.py - b.py);

    // Structure mask: tracks which pixels are covered
    const structureMask = new Uint8Array(res * res);

    // ------------------------------------------------------------------
    // 6. Shadow pass
    // ------------------------------------------------------------------
    for (const s of structures) {
      this._stampShadow(pixels, res, s);
    }

    // ------------------------------------------------------------------
    // 7. Sprite pass
    // ------------------------------------------------------------------
    for (const s of structures) {
      this._stampSprite(pixels, res, s, palette, structureMask);
    }

    return structureMask;
  }

  // -----------------------------------------------------------------------
  // River exclusion mask (same approach as TreeRenderer)
  // -----------------------------------------------------------------------
  private _buildRiverMask(
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
  ): Uint8Array {
    const N = resolution;
    const mask = new Uint8Array(N * N);
    const scale = topo.size / N;
    const { points } = topo.mesh;

    const RIVER_MIN = 25;
    const maxAccum = Math.max(RIVER_MIN + 1, Math.max(...Array.from(hydro.flowAccumulation)));
    const logMin = Math.log(RIVER_MIN);
    const logRange = Math.log(maxAccum) - logMin;

    for (const path of hydro.rivers) {
      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];
        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        const flow = Math.max(RIVER_MIN, hydro.flowAccumulation[rA], hydro.flowAccumulation[rB]);
        const t = Math.min(1, (Math.log(flow) - logMin) / logRange);
        const riverWidth = Math.max(1, Math.ceil(t * 6));
        const totalWidth = riverWidth + RIVER_BUFFER * 2;

        this._markThickLine(mask, N, x0, y0, x1, y1, totalWidth);
      }
    }
    return mask;
  }

  private _markThickLine(
    mask: Uint8Array, N: number,
    x0: number, y0: number, x1: number, y1: number,
    width: number,
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    const r = (width - 1) >> 1;

    while (true) {
      for (let oy = -r; oy <= r; oy++) {
        const py = cy + oy;
        if (py < 0 || py >= N) continue;
        for (let ox = -r; ox <= r; ox++) {
          const px = cx + ox;
          if (px < 0 || px >= N) continue;
          mask[py * N + px] = 1;
        }
      }
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }

  // -----------------------------------------------------------------------
  // Shadow stamp
  // -----------------------------------------------------------------------
  private _stampShadow(pixels: Uint32Array, N: number, s: StructureInstance): void {
    const { px: tx, py: ty, template } = s;
    const sw = template.w;
    const sh = Math.max(2, Math.ceil(template.h * 0.3));
    const sx = tx + SHADOW_OFFSET_X - Math.floor(sw / 2);
    const sy = ty + SHADOW_OFFSET_Y;

    for (let dy = 0; dy < sh; dy++) {
      for (let dx = 0; dx < sw; dx++) {
        const px = sx + dx;
        const py = sy + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        // Rounded rectangle
        const ex = (dx - sw / 2) / (sw / 2);
        const ey = (dy - sh / 2) / (sh / 2);
        if (ex * ex + ey * ey > 1.2) continue;

        const idx = py * N + px;
        pixels[idx] = darkenPixel(pixels[idx], SHADOW_DARKEN);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sprite stamp with directional lighting
  // -----------------------------------------------------------------------
  private _stampSprite(
    pixels: Uint32Array, N: number,
    s: StructureInstance,
    palette: StructurePalette,
    mask: Uint8Array,
  ): void {
    const { px: tx, py: ty, template, flipped } = s;
    const { w, h, data, anchorY } = template;

    const startX = tx - Math.floor(w / 2);
    const startY = ty - anchorY;

    // Bounding box for roof (for directional lighting)
    let roofMinX = w, roofMaxX = 0, roofMinY = h, roofMaxY = 0;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (data[sy * w + sx] === R) {
          roofMinX = Math.min(roofMinX, sx);
          roofMaxX = Math.max(roofMaxX, sx);
          roofMinY = Math.min(roofMinY, sy);
          roofMaxY = Math.max(roofMaxY, sy);
        }
      }
    }
    const roofCX = (roofMinX + roofMaxX) / 2;
    const roofCY = (roofMinY + roofMaxY) / 2;
    const roofRadX = Math.max(1, (roofMaxX - roofMinX) / 2);
    const roofRadY = Math.max(1, (roofMaxY - roofMinY) / 2);

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        let color: number;
        switch (cell) {
          case W: {
            // Wall: directional shading left→right
            const t = sx / (w - 1);
            const shadeIdx = Math.max(0, Math.min(4, Math.floor(t * 4.99)));
            color = palette.wall[shadeIdx];
            break;
          }
          case R: {
            // Roof: directional lighting from NW
            const relX = (srcX - roofCX) / roofRadX;
            const relY = (sy - roofCY) / roofRadY;
            const lightDot = relX * LIGHT_DIR_X + relY * LIGHT_DIR_Y;
            const shadeIdx = Math.max(0, Math.min(4,
              Math.floor((lightDot + 1) / 2 * 4.99)));
            color = palette.roof[shadeIdx];
            break;
          }
          case S: {
            // Stone foundation
            const t = sx / (w - 1);
            const shadeIdx = Math.max(0, Math.min(4, Math.floor(t * 4.99)));
            color = palette.stone[shadeIdx];
            break;
          }
          case D:
            color = palette.door;
            break;
          case N:
            color = palette.window;
            break;
          case P: {
            // Porch planks: simple 3-shade variation
            const pi = Math.min(2, Math.floor((sx / (w - 1)) * 2.99));
            color = palette.porch[pi];
            break;
          }
          case K: {
            // Chimney
            const ci = Math.min(2, Math.floor((sy / (h - 1)) * 2.99));
            color = palette.chimney[ci];
            break;
          }
          default:
            continue;
        }

        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        const idx = py * N + px;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function darkenPixel(abgr: number, factor: number): number {
  const r = Math.floor((abgr & 0xff) * factor);
  const g = Math.floor(((abgr >> 8) & 0xff) * factor);
  const b = Math.floor(((abgr >> 16) & 0xff) * factor);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
