/**
 * StructureRenderer — places thatched-roof cottages on lowland/highland regions.
 *
 * Each duchy capital gets a larger manor sized to fill its Voronoi cell;
 * other eligible regions get small cottages based on density heuristics.
 *
 * Sprites use a 3/4 perspective with visible front face, right side wall,
 * and angled roof.  Shadows are projected to the right on the ground plane.
 *
 * Rendering is split into two phases:
 *   1. placeStructures() — computes positions + structureMask (before trees)
 *   2. renderSprites()   — stamps shadows + sprites (after duchy borders)
 */

import PoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { Duchy } from '../state/Duchy';
import type { LoadedSprite } from './SpriteLoader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;
const SHADOW_DARKEN = 0.50;
const SHADOW_SKEW_X = 0.45;
const SHADOW_SKEW_Y = 0.35;
const EDGE_MARGIN = 12;
const RIVER_BUFFER = 8;
const MIN_COTTAGE_SPACING = 28;
const MAX_COTTAGE_SPACING = 50;
const COTTAGE_DENSITY = 0.12;

const MAX_BUILDING_ELEVATION = 0.38;
const MIN_BUILDING_ELEVATION = 0.10;

// ---------------------------------------------------------------------------
// Pixel cell types
// ---------------------------------------------------------------------------
const _ = 0;  // transparent
const W = 1;  // wall (wood) — front face
const R = 2;  // roof (thatch)
const D = 3;  // door
const S = 4;  // stone foundation
const N = 5;  // window
const P = 6;  // porch / wooden platform
const K = 7;  // chimney
const E = 8;  // east/side wall (3/4 depth)
const M = 9;  // smoke

// ---------------------------------------------------------------------------
// Sprite templates — 3/4 perspective (small cottages)
// ---------------------------------------------------------------------------
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

// Small cottage 3/4 (9×10)
const COTTAGE_SMALL: SpriteTemplate = {
  w: 9, h: 10, anchorY: 9, data: [
    _, _, _, M, _, _, _, _, _,
    _, _, _, K, M, _, _, _, _,
    _, _, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, _, _,
    _, W, W, N, W, E, E, _, _,
    _, W, W, D, W, E, E, _, _,
    _, S, S, S, S, S, S, _, _,
    _, _, P, P, P, P, _, _, _,
    _, _, _, P, P, _, _, _, _,
  ],
};

// Medium cottage 3/4 (10×11)
const COTTAGE_MEDIUM: SpriteTemplate = {
  w: 10, h: 11, anchorY: 10, data: [
    _, _, _, _, M, _, _, _, _, _,
    _, _, _, K, M, _, _, _, _, _,
    _, _, R, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, _, _,
    _, W, W, N, W, W, E, E, _, _,
    _, W, W, W, W, W, E, E, _, _,
    _, W, W, D, W, W, E, E, _, _,
    _, S, S, S, S, S, S, S, _, _,
    _, _, P, P, P, P, P, _, _, _,
    _, _, _, P, P, P, _, _, _, _,
  ],
};

const COTTAGE_TEMPLATES: SpriteTemplate[] = [COTTAGE_SMALL, COTTAGE_MEDIUM];

// ---------------------------------------------------------------------------
// Manor templates — hand-crafted at 3 sizes for clean pixel art
// ---------------------------------------------------------------------------

// Small manor 3/4 (13×13) — chimney on left
const MANOR_SMALL: SpriteTemplate = {
  w: 13, h: 13, anchorY: 12, data: [
    _, _, _, _, M, _, _, _, _, _, _, _, _,
    _, _, _, K, M, _, _, _, _, _, _, _, _,
    _, _, _, R, R, R, R, R, _, _, _, _, _,
    _, _, R, R, R, R, R, R, R, _, _, _, _,
    _, R, R, R, R, R, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, R, R, R, _, _, _,
    _, W, W, N, W, W, N, W, E, E, E, _, _,
    _, W, W, W, W, W, W, W, E, E, E, _, _,
    _, W, W, W, D, W, W, W, E, E, E, _, _,
    _, S, S, S, S, S, S, S, S, S, S, _, _,
    _, _, P, P, P, P, P, P, P, P, _, _, _,
    _, _, _, P, P, P, P, P, P, _, _, _, _,
    _, _, _, _, P, P, P, P, _, _, _, _, _,
  ],
};

// Medium manor 3/4 (15×15) — chimney on right, wider front
const MANOR_MEDIUM: SpriteTemplate = {
  w: 15, h: 15, anchorY: 14, data: [
    _, _, _, _, _, _, _, _, _, M, _, _, _, _, _,
    _, _, _, _, _, _, _, _, K, M, _, _, _, _, _,
    _, _, _, _, R, R, R, R, R, R, R, _, _, _, _,
    _, _, _, R, R, R, R, R, R, R, R, R, _, _, _,
    _, _, R, R, R, R, R, R, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, _, _,
    _, W, W, N, W, W, N, W, W, N, E, E, E, _, _,
    _, W, W, W, W, W, W, W, W, W, E, E, E, _, _,
    _, W, W, W, W, D, W, W, W, W, E, E, E, _, _,
    _, S, S, S, S, S, S, S, S, S, S, S, S, _, _,
    _, _, P, P, P, P, P, P, P, P, P, P, _, _, _,
    _, _, _, P, P, P, P, P, P, P, P, _, _, _, _,
    _, _, _, _, P, P, P, P, P, P, _, _, _, _, _,
    _, _, _, _, _, P, P, P, P, _, _, _, _, _, _,
  ],
};

// Large manor 3/4 (18×17) — two chimneys, grand facade
const MANOR_LARGE: SpriteTemplate = {
  w: 18, h: 17, anchorY: 16, data: [
    _, _, _, _, _, _, _, _, _, _, M, _, _, _, _, _, _, _,
    _, _, _, _, _, K, R, R, R, K, M, _, _, _, _, _, _, _,
    _, _, _, _, R, R, R, R, R, R, R, R, _, _, _, _, _, _,
    _, _, _, R, R, R, R, R, R, R, R, R, R, _, _, _, _, _,
    _, _, R, R, R, R, R, R, R, R, R, R, R, R, _, _, _, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, R, R, R, R, R, R, R, R, _, _, _,
    _, W, W, N, W, W, N, W, W, N, W, W, E, E, E, E, _, _,
    _, W, W, W, W, W, W, W, W, W, W, W, E, E, E, E, _, _,
    _, W, W, W, W, W, W, D, W, W, W, W, E, E, E, E, _, _,
    _, S, S, S, S, S, S, S, S, S, S, S, S, S, S, S, _, _,
    _, _, P, P, P, P, P, P, P, P, P, P, P, P, P, _, _, _,
    _, _, _, P, P, P, P, P, P, P, P, P, P, P, _, _, _, _,
    _, _, _, _, P, P, P, P, P, P, P, P, P, _, _, _, _, _,
    _, _, _, _, _, P, P, P, P, P, P, P, _, _, _, _, _, _,
    _, _, _, _, _, _, P, P, P, P, P, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, P, P, P, _, _, _, _, _, _, _, _,
  ],
};

const MANOR_TEMPLATES: SpriteTemplate[] = [MANOR_SMALL, MANOR_MEDIUM, MANOR_LARGE];

/** Pick a manor template based on cell size + rng for variation. */
function pickManor(cellW: number, cellH: number, rng: () => number): SpriteTemplate {
  const cellDim = Math.min(cellW, cellH);
  // Pick size based on cell, with some random variation
  let idx: number;
  if (cellDim >= 20) {
    idx = rng() < 0.4 ? 2 : 1;    // large or medium
  } else if (cellDim >= 15) {
    idx = rng() < 0.5 ? 1 : 0;    // medium or small
  } else {
    idx = rng() < 0.3 ? 1 : 0;    // mostly small
  }
  return MANOR_TEMPLATES[idx];
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------
interface StructurePalette {
  wall: number[];     // 5 shades
  roof: number[];     // 5 shades
  stone: number[];    // 5 shades
  door: number;
  window: number;
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
  chimney: [0x887070, 0x988080, 0xa89090],
};

const PALETTE_WINTER: StructurePalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340, 0x806248, 0x927150],
  roof:    [0xc8c8d0, 0xd4d4dc, 0xe0e0e8, 0xeaeaf0, 0xf4f4f8],
  stone:   [0x585058, 0x686068, 0x787078, 0x888088, 0x989098],
  door:    0x3a2810,
  window:  0x3a78a8,
  porch:   [0xb0b0b8, 0xc0c0c8, 0xd0d0d8],
  chimney: [0x887070, 0x988080, 0xa89090],
};

const PALETTE_SPRING: StructurePalette = { ...PALETTE_SUMMER };
const PALETTE_FALL: StructurePalette = {
  ...PALETTE_SUMMER,
  roof: [0x7a6a30, 0x8c7c40, 0x9e8e50, 0xb09e58, 0xc0ae60],
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
export interface StructureInstance {
  px: number;
  py: number;
  template: SpriteTemplate;
  flipped: boolean;
  isCapital: boolean;
  duchyIndex: number;  // which duchy this capital belongs to (-1 for cottages)
}

// ---------------------------------------------------------------------------
// StructureRenderer
// ---------------------------------------------------------------------------
export class StructureRenderer {

  /**
   * Phase 1: Place structures and build an exclusion mask (no pixel drawing).
   */
  placeStructures(
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
    duchies: Duchy[],
    regionToDuchy: Int8Array,
  ): { structures: StructureInstance[]; mask: Uint8Array } {
    const rng = mulberry32(seed ^ 0xBEEF0042);
    const res = resolution;
    const scale = topo.size / res;
    const { points } = topo.mesh;
    const numRegions = topo.mesh.numRegions;

    // Spatial grid for nearest-region lookup
    const cellSize = 40;
    const gridW = Math.ceil(topo.size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) grid[gy * gridW + gx].push(r);
    }

    const riverMask = this._buildRiverMask(topo, hydro, res);

    // ------------------------------------------------------------------
    // Capital manors — sized to fill their Voronoi cell
    // ------------------------------------------------------------------
    const structures: StructureInstance[] = [];

    for (let di = 0; di < duchies.length; di++) {
      const duchy = duchies[di];
      const cr = duchy.capitalRegion;
      if (cr < 0 || cr >= numRegions) continue;

      const px = Math.floor(points[cr].x / scale);
      const py = Math.floor(points[cr].y / scale);

      if (px < EDGE_MARGIN || py < EDGE_MARGIN ||
          px >= res - EDGE_MARGIN || py >= res - EDGE_MARGIN) continue;

      // Get Voronoi cell polygon and compute bounding box in pixel space
      const poly = topo.mesh.voronoiPolygon(cr);
      if (poly.length < 3) continue;

      let minPx = Infinity, maxPx = -Infinity;
      let minPy = Infinity, maxPy = -Infinity;
      for (const pt of poly) {
        const cx = pt.x / scale;
        const cy = pt.y / scale;
        if (cx < minPx) minPx = cx;
        if (cx > maxPx) maxPx = cx;
        if (cy < minPy) minPy = cy;
        if (cy > maxPy) maxPy = cy;
      }

      const cellW = Math.round(maxPx - minPx);
      const cellH = Math.round(maxPy - minPy);

      // Pick a manor template based on cell size with random variation
      const manorRng = mulberry32(seed ^ (cr * 0x9E3779B9));
      const template = pickManor(cellW, cellH, manorRng);

      structures.push({
        px,
        py,
        template,
        flipped: false,
        isCapital: true,
        duchyIndex: di,
      });
    }

    // ------------------------------------------------------------------
    // Poisson disk sampling for village cottages
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

      if (px < EDGE_MARGIN || py < EDGE_MARGIN ||
          px >= res - EDGE_MARGIN || py >= res - EDGE_MARGIN) continue;

      if (riverMask[py * res + px]) continue;

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

      const elev = topo.elevation[bestR];
      const terrain = topo.terrainType[bestR];
      if (elev < MIN_BUILDING_ELEVATION || elev > MAX_BUILDING_ELEVATION) continue;
      if (terrain !== 'lowland' && terrain !== 'highland' && terrain !== 'coast') continue;

      if (regionToDuchy[bestR] < 0) continue;

      let tooCloseToCapital = false;
      for (const s of structures) {
        if (!s.isCapital) continue;
        const d2 = (px - s.px) ** 2 + (py - s.py) ** 2;
        if (d2 < 20 * 20) { tooCloseToCapital = true; break; }
      }
      if (tooCloseToCapital) continue;

      const moisture = hydro.moisture[bestR];
      let keepChance = COTTAGE_DENSITY;
      if (terrain === 'lowland') keepChance *= 1.5;
      if (moisture > 0.4) keepChance *= 1.4;
      if (rng() > keepChance) continue;

      const templateIdx = rng() < 0.6 ? 0 : 1;

      structures.push({
        px,
        py,
        template: COTTAGE_TEMPLATES[templateIdx],
        flipped: rng() < 0.5,
        isCapital: false,
        duchyIndex: -1,
      });
    }

    structures.sort((a, b) => a.py - b.py);

    const mask = new Uint8Array(res * res);
    for (const s of structures) {
      this._fillMask(mask, res, s);
    }

    return { structures, mask };
  }

  /**
   * Phase 2: Render shadows + sprites into pixels.
   * If manorSprites is provided, capital buildings use the loaded PNGs directly,
   * cycling through the array based on duchy index.
   */
  renderSprites(
    pixels: Uint32Array,
    resolution: number,
    structures: StructureInstance[],
    season: Season = Season.Summer,
    manorSprites?: LoadedSprite[],
  ): Uint8Array {
    const palette = getPalette(season);
    const buildingMask = new Uint8Array(resolution * resolution);

    // Shadow pass — shadows don't need to be in buildingMask
    for (const s of structures) {
      this._stampShadow(pixels, resolution, s);
    }
    // Sprite pass — track building pixels in mask
    for (const s of structures) {
      if (s.isCapital && manorSprites && manorSprites.length > 0) {
        const sprite = manorSprites[s.duchyIndex % manorSprites.length];
        this._stampLoadedSprite(pixels, resolution, s, sprite);
      } else {
        this._stampSprite(pixels, resolution, s, palette);
      }
      this._fillMask(buildingMask, resolution, s);
    }

    return buildingMask;
  }

  // -----------------------------------------------------------------------
  // Fill mask without drawing
  // -----------------------------------------------------------------------
  private _fillMask(mask: Uint8Array, N: number, s: StructureInstance): void {
    const { px: tx, py: ty, template, flipped } = s;
    const { w, h, data, anchorY } = template;
    const startX = tx - Math.floor(w / 2);
    const startY = ty - anchorY;

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0 || cell === M) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        mask[py * N + px] = 1;
      }
    }
  }

  // -----------------------------------------------------------------------
  // River exclusion mask
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
  // Shadow stamp — projected to the right on the ground plane
  // -----------------------------------------------------------------------
  private _stampShadow(pixels: Uint32Array, N: number, s: StructureInstance): void {
    const { px: tx, py: ty, template } = s;
    const { w, h, data, anchorY } = template;
    const startX = tx - Math.floor(w / 2);
    const startY = ty - anchorY;

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const cell = data[sy * w + sx];
        if (cell === 0 || cell === M) continue;

        const heightAboveBase = anchorY - sy;
        const shadowDx = Math.round(heightAboveBase * SHADOW_SKEW_X) + 1;
        const shadowDy = Math.round(heightAboveBase * SHADOW_SKEW_Y);

        const px = startX + sx + shadowDx;
        const py = startY + sy + shadowDy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const idx = py * N + px;
        pixels[idx] = darkenPixel(pixels[idx], SHADOW_DARKEN);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sprite stamp with directional lighting (3/4 perspective)
  // -----------------------------------------------------------------------
  private _stampSprite(
    pixels: Uint32Array, N: number,
    s: StructureInstance,
    palette: StructurePalette,
  ): void {
    const { px: tx, py: ty, template, flipped } = s;
    const { w, h, data, anchorY } = template;

    const startX = tx - Math.floor(w / 2);
    const startY = ty - anchorY;

    // Bounding box for roof (directional lighting)
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

        const idx = py * N + px;

        // Smoke: alpha-blend white wisps
        if (cell === M) {
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const alpha = 0.55;
          const nr = Math.round(er + (0xe8 - er) * alpha);
          const ng = Math.round(eg + (0xe4 - eg) * alpha);
          const nb = Math.round(eb + (0xe0 - eb) * alpha);
          pixels[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
          continue;
        }

        let color: number;
        switch (cell) {
          case W: {
            const t = sx / (w - 1);
            const shadeIdx = Math.max(0, Math.min(4, Math.floor(t * 4.99)));
            color = palette.wall[shadeIdx];
            break;
          }
          case E: {
            color = palette.wall[1];
            break;
          }
          case R: {
            const relX = (srcX - roofCX) / roofRadX;
            const relY = (sy - roofCY) / roofRadY;
            const lightDot = relX * LIGHT_DIR_X + relY * LIGHT_DIR_Y;
            const shadeIdx = Math.max(0, Math.min(4,
              Math.floor((lightDot + 1) / 2 * 4.99)));
            color = palette.roof[shadeIdx];
            break;
          }
          case S: {
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
            const pi = Math.min(2, Math.floor((sx / (w - 1)) * 2.99));
            color = palette.porch[pi];
            break;
          }
          case K: {
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
        pixels[idx] = packABGR(r, g, b);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stamp a loaded PNG sprite (for manor replacement)
  // Renders at 50% scale using nearest-neighbor sampling.
  // -----------------------------------------------------------------------
  private _stampLoadedSprite(
    pixels: Uint32Array, N: number,
    s: StructureInstance,
    sprite: LoadedSprite,
  ): void {
    const { px: tx, py: ty, flipped } = s;
    const { w: srcW, h: srcH, pixels: srcPixels } = sprite;

    const scale = 0.5;
    const dstW = Math.round(srcW * scale);
    const dstH = Math.round(srcH * scale);

    const startX = tx - Math.floor(dstW / 2);
    const startY = ty - dstH + Math.floor(dstH * 0.15); // anchor near bottom

    for (let dy = 0; dy < dstH; dy++) {
      const srcY = Math.floor(dy / scale);
      for (let dx = 0; dx < dstW; dx++) {
        const srcX = Math.floor(dx / scale);
        const flippedX = flipped ? (srcW - 1 - srcX) : srcX;
        const abgr = srcPixels[srcY * srcW + flippedX];

        // Skip fully transparent pixels
        const alpha = (abgr >>> 24) & 0xff;
        if (alpha < 10) continue;

        const px = startX + dx;
        const py = startY + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const dstIdx = py * N + px;

        // Alpha-blend if semi-transparent
        if (alpha < 245) {
          const a = alpha / 255;
          const sr = abgr & 0xff;
          const sg = (abgr >> 8) & 0xff;
          const sb = (abgr >> 16) & 0xff;
          const dst = pixels[dstIdx];
          const dr = dst & 0xff;
          const dg = (dst >> 8) & 0xff;
          const db = (dst >> 16) & 0xff;
          const nr = Math.round(sr * a + dr * (1 - a));
          const ng = Math.round(sg * a + dg * (1 - a));
          const nb = Math.round(sb * a + db * (1 - a));
          pixels[dstIdx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
        } else {
          pixels[dstIdx] = abgr;
        }
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
